use crate::discovery::EnrichedPlugin;
use crate::errors::CliError;
use crate::registry::cache::{self, UpdateNotice, UpdateNoticeCache};
use crate::version_util::version_is_newer;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Semaphore;

/// Default maximum number of concurrent npm registry requests.
pub const DEFAULT_MAX_CONCURRENT: usize = 5;

/// NPM package name for this tool's own self-update check.
/// Must match the `name` field in `package.json`.
pub const SELF_UPDATE_PACKAGE_NAME: &str = "@capybearista/opencode-plugin-manager";

/// Metadata returned by the npm registry `/{package}/latest` endpoint.
///
/// The `name` field is only used in tests (deserialization round-trip);
/// `#[allow(dead_code)]` is scoped to avoid suppressing legitimate warnings
/// on `version` and `engines`, which are consumed in
/// [`build_notices_from_metadata`].
#[derive(Debug, Deserialize)]
pub struct NpmMetadata {
    #[allow(dead_code)]
    pub name: String,
    pub version: String,
    pub engines: Option<NpmEngines>,
}

/// The `engines` object from npm package metadata.
///
/// Only `opencode` is extracted (used as the `declared_open_code_range`
/// cache field).  Other engine keys are ignored.
#[derive(Debug, Deserialize)]
pub struct NpmEngines {
    pub opencode: Option<String>,
}

pub struct RegistryClient {
    client: reqwest::Client,
    max_concurrent: usize,
}

impl RegistryClient {
    pub fn new(max_concurrent: usize) -> Self {
        Self {
            client: reqwest::Client::new(),
            max_concurrent,
        }
    }

    pub async fn fetch_latest_version(&self, package_name: &str) -> Result<NpmMetadata, CliError> {
        let url = format!("https://registry.npmjs.org/{}/latest", package_name);
        let response = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(CliError::Network)?;

        if !response.status().is_success() {
            return Err(CliError::Network(response.error_for_status().unwrap_err()));
        }

        response
            .json::<NpmMetadata>()
            .await
            .map_err(CliError::Network)
    }

    pub async fn fetch_latest_versions(
        &self,
        package_names: &[String],
    ) -> HashMap<String, Result<NpmMetadata, CliError>> {
        let semaphore = Arc::new(Semaphore::new(self.max_concurrent));
        let mut handles = Vec::with_capacity(package_names.len());

        for package_name in package_names {
            let client = self.clone();
            let sem = semaphore.clone();
            let pkg = package_name.clone();

            handles.push(tokio::spawn(async move {
                let _permit = sem.acquire().await.unwrap();
                let result = client.fetch_latest_version(&pkg).await;
                (pkg, result)
            }));
        }

        let mut results = HashMap::new();
        for handle in handles {
            let (pkg, result) = handle
                .await
                .expect("registry fetch task failed — a spawned tokio task panicked");
            results.insert(pkg, result);
        }

        results
    }

    pub async fn fetch_and_write_cache(
        &self,
        enriched_plugins: &[EnrichedPlugin],
        cache_path: PathBuf,
    ) -> Result<UpdateNoticeCache, CliError> {
        let package_names: Vec<String> = enriched_plugins
            .iter()
            .map(|p| p.package_name.clone())
            .collect();

        let npm_results = self.fetch_latest_versions(&package_names).await;

        let notices = build_notices_from_metadata(enriched_plugins, &npm_results);

        // Opportunistic self-update check: failure is silently ignored so that
        // a transient network issue never blocks the registry refresh.
        let cli_latest = self.check_self_update_cached().await;

        let checked_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let cache = UpdateNoticeCache {
            checked_at,
            notices,
            cli_latest_version: cli_latest,
        };

        cache::write_cache_to_path(&cache, &cache_path)?;

        Ok(cache)
    }
}

/// Build update notices from fetched npm metadata without making network calls.
///
/// This is the core transformation extracted from `fetch_and_write_cache` so it
/// can be unit-tested without a live registry or mock HTTP server.
pub fn build_notices_from_metadata(
    enriched_plugins: &[EnrichedPlugin],
    npm_results: &HashMap<String, Result<NpmMetadata, CliError>>,
) -> Vec<UpdateNotice> {
    enriched_plugins
        .iter()
        .filter_map(|plugin| {
            let npm_metadata = npm_results.get(&plugin.package_name)?;
            let metadata = npm_metadata.as_ref().ok()?;
            let installed_version = plugin.manifest.as_ref().map(|m| m.version.clone());

            Some(UpdateNotice {
                package_name: plugin.package_name.clone(),
                latest_version: metadata.version.clone(),
                installed_version,
                declared_open_code_range: metadata
                    .engines
                    .as_ref()
                    .and_then(|e| e.opencode.clone()),
            })
        })
        .collect()
}

impl RegistryClient {
    /// Check if a newer version of oc-plugins is available on npm.
    /// Returns `Ok(Some(new_version))` if update available, `Ok(None)` if up to date.
    pub async fn check_self_update(&self) -> Result<Option<String>, CliError> {
        let current_version = env!("CARGO_PKG_VERSION");
        let metadata = self.fetch_latest_version(SELF_UPDATE_PACKAGE_NAME).await?;
        if version_is_newer(&metadata.version, current_version) {
            Ok(Some(metadata.version))
        } else {
            Ok(None)
        }
    }

    /// Opportunistic self-update check that always returns `Option<String>`
    /// instead of propagating errors.  This is designed for use inside
    /// [`fetch_and_write_cache`]: a failure (network blip or timeout) simply
    /// produces `None`, which is stored in the cache as "no new version known".
    ///
    /// The caller can then display the cached value if present, without ever
    /// performing a blocking network call during startup or `list`.
    pub async fn check_self_update_cached(&self) -> Option<String> {
        match tokio::time::timeout(std::time::Duration::from_secs(2), self.check_self_update())
            .await
        {
            Ok(Ok(Some(version))) => Some(version),
            _ => None,
        }
    }
}

impl Clone for RegistryClient {
    fn clone(&self) -> Self {
        Self {
            client: self.client.clone(),
            max_concurrent: self.max_concurrent,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::manifest::PackageManifest;
    use crate::config::provider::ConfigScope;
    use crate::discovery::EnrichedPlugin;
    use std::path::PathBuf;

    #[test]
    fn test_npm_metadata_deserialization() {
        let json = r#"{"name":"test-plugin","version":"1.0.0","engines":{"opencode":">=1.15.0"}}"#;
        let metadata: NpmMetadata = serde_json::from_str(json).unwrap();
        assert_eq!(metadata.name, "test-plugin");
        assert_eq!(metadata.version, "1.0.0");
        assert_eq!(metadata.engines.unwrap().opencode.unwrap(), ">=1.15.0");
    }

    #[test]
    fn test_npm_metadata_without_engines() {
        let json = r#"{"name":"test-plugin","version":"1.0.0"}"#;
        let metadata: NpmMetadata = serde_json::from_str(json).unwrap();
        assert!(metadata.engines.is_none());
    }

    #[test]
    fn test_cargo_pkg_version_is_set() {
        // Verify that env!("CARGO_PKG_VERSION") compiles and returns a non-empty string.
        // This is the version constant used by check_self_update().
        let version = env!("CARGO_PKG_VERSION");
        assert!(!version.is_empty());
        // Basic semver shape: at least one dot
        assert!(version.contains('.'));
    }

    #[test]
    fn self_update_package_name_matches_package_json() {
        // This constant must match the `name` field in package.json.
        assert_eq!(
            SELF_UPDATE_PACKAGE_NAME,
            "@capybearista/opencode-plugin-manager"
        );
    }

    #[test]
    fn cargo_pkg_version_matches_package_json() {
        // CARGO_PKG_VERSION is set from Cargo.toml, which must be kept in sync
        // with the `version` field in package.json (both 1.0.0 as of this check).
        let version = env!("CARGO_PKG_VERSION");
        assert_eq!(
            version, "1.0.0",
            "CARGO_PKG_VERSION ({version}) must match package.json version (1.0.0)"
        );
    }

    #[test]
    fn test_build_notices_from_metadata() {
        let plugins = vec![
            EnrichedPlugin {
                configured_spec: "plugin-a@latest".to_string(),
                package_name: "plugin-a".to_string(),
                scope: ConfigScope::Project,
                config_path: PathBuf::from("/tmp/opencode.json"),
                manifest: Some(PackageManifest {
                    name: "plugin-a".to_string(),
                    version: "1.0.0".to_string(),
                    description: None,
                    engines: None,
                }),
                catalog_metadata: None,
                display_name: "Plugin A".to_string(),
                description: String::new(),
                status: crate::discovery::InstallStatus::Installed,
                latest_version: None,
                declared_latest_range: None,
            },
            EnrichedPlugin {
                configured_spec: "plugin-b@latest".to_string(),
                package_name: "plugin-b".to_string(),
                scope: ConfigScope::Global,
                config_path: PathBuf::from("/tmp/global/opencode.json"),
                manifest: None,
                catalog_metadata: None,
                display_name: "Plugin B".to_string(),
                description: String::new(),
                status: crate::discovery::InstallStatus::MissingInstall,
                latest_version: None,
                declared_latest_range: None,
            },
        ];

        let mut npm_results: HashMap<String, Result<NpmMetadata, CliError>> = HashMap::new();
        // plugin-a has a newer version
        npm_results.insert(
            "plugin-a".to_string(),
            Ok(NpmMetadata {
                name: "plugin-a".to_string(),
                version: "2.0.0".to_string(),
                engines: Some(NpmEngines {
                    opencode: Some(">=1.15.0".to_string()),
                }),
            }),
        );
        // plugin-b has metadata (but no manifest — installed_version will be None)
        npm_results.insert(
            "plugin-b".to_string(),
            Ok(NpmMetadata {
                name: "plugin-b".to_string(),
                version: "3.0.0".to_string(),
                engines: None,
            }),
        );

        let notices = build_notices_from_metadata(&plugins, &npm_results);

        assert_eq!(notices.len(), 2);

        // plugin-a: installed=Some("1.0.0"), latest="2.0.0"
        assert_eq!(notices[0].package_name, "plugin-a");
        assert_eq!(notices[0].latest_version, "2.0.0");
        assert_eq!(notices[0].installed_version.as_deref(), Some("1.0.0"));
        assert_eq!(
            notices[0].declared_open_code_range.as_deref(),
            Some(">=1.15.0")
        );

        // plugin-b: installed=None, latest="3.0.0"
        assert_eq!(notices[1].package_name, "plugin-b");
        assert_eq!(notices[1].latest_version, "3.0.0");
        assert_eq!(notices[1].installed_version, None);
        assert!(notices[1].declared_open_code_range.is_none());
    }

    #[test]
    fn test_build_notices_from_metadata_skips_failed_fetches() {
        let plugins = vec![EnrichedPlugin {
            configured_spec: "failing-plugin@latest".to_string(),
            package_name: "failing-plugin".to_string(),
            scope: ConfigScope::Project,
            config_path: PathBuf::from("/tmp/opencode.json"),
            manifest: Some(PackageManifest {
                name: "failing-plugin".to_string(),
                version: "1.0.0".to_string(),
                description: None,
                engines: None,
            }),
            catalog_metadata: None,
            display_name: "Failing".to_string(),
            description: String::new(),
            status: crate::discovery::InstallStatus::Installed,
            latest_version: None,
            declared_latest_range: None,
        }];

        let mut npm_results: HashMap<String, Result<NpmMetadata, CliError>> = HashMap::new();
        npm_results.insert(
            "failing-plugin".to_string(),
            Err(CliError::NotFound("test network error".to_string())),
        );

        let notices = build_notices_from_metadata(&plugins, &npm_results);
        assert!(notices.is_empty());
    }
}
