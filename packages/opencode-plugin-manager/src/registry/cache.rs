use crate::errors::CliError;
use crate::version_util::versions_equal;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Deserialize, Serialize)]
pub struct UpdateNoticeCache {
    pub checked_at: u64,
    pub notices: Vec<UpdateNotice>,
    /// Latest available CLI version, populated by the self-update check
    /// during registry refresh.  `None` if the check failed or was not
    /// performed (e.g. because the cache was read from a previous session
    /// before this field existed).
    ///
    /// The `#[serde(default)]` attribute ensures that caches written by
    /// earlier versions of oc-plugins (which lack this field) still
    /// deserialize without error — they simply get `None`.
    #[serde(default)]
    pub cli_latest_version: Option<String>,
}

impl UpdateNoticeCache {
    /// Returns the count of notices that represent a genuinely available update.
    ///
    /// A notice is considered outdated only when `installed_version` is present
    /// (the plugin is actually installed) and differs from `latest_version`.
    /// Notices with `installed_version == None` indicate the plugin is not installed
    /// and should not be reported as an available update.
    ///
    /// Uses [`versions_equal`] for semver-aware comparison with string fallback,
    /// keeping this consistent with [`classify_plugins`](crate::discovery::classify_plugins).
    pub fn outdated_count(&self) -> usize {
        self.notices
            .iter()
            .filter(|n| {
                n.installed_version
                    .as_ref()
                    .is_some_and(|installed| !versions_equal(installed, &n.latest_version))
            })
            .count()
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct UpdateNotice {
    pub package_name: String,
    pub latest_version: String,
    pub installed_version: Option<String>,
    /// The `engines.opencode` range declared by the plugin's npm package.
    ///
    /// Named `declared_open_code_range` (not `declared_opencode_range`) because
    /// "OpenCode" is the project's canonical two-word display name; using the
    /// full form avoids ambiguity with runtime-internal labels while staying
    /// consistent with the `engines.opencode` JSON key in npm metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub declared_open_code_range: Option<String>,
}

pub fn read_update_notice_cache() -> Option<UpdateNoticeCache> {
    read_update_notice_cache_from_path(default_notice_cache_path())
}

pub fn read_update_notice_cache_from_path(path: impl AsRef<Path>) -> Option<UpdateNoticeCache> {
    let content = fs::read_to_string(path).ok()?;
    let cache: UpdateNoticeCache = serde_json::from_str(&content).ok()?;

    if is_fresh(cache.checked_at) {
        Some(cache)
    } else {
        None
    }
}

pub fn default_notice_cache_path() -> std::path::PathBuf {
    directories::ProjectDirs::from("", "", "oc-plugins")
        .map(|dirs| dirs.cache_dir().join("notice.json"))
        .unwrap_or_else(|| std::path::PathBuf::from("notice.json"))
}

/// Write the update notice cache to a specific path.
pub fn write_cache_to_path(cache: &UpdateNoticeCache, path: &Path) -> Result<(), CliError> {
    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| CliError::Io {
            path: parent.display().to_string(),
            source: e,
        })?;
    }
    let json = serde_json::to_string_pretty(cache).map_err(|e| CliError::Parse {
        detail: format!("failed to serialize cache: {e}"),
    })?;
    std::fs::write(path, json).map_err(|e| CliError::Io {
        path: path.display().to_string(),
        source: e,
    })?;
    Ok(())
}

fn is_fresh(checked_at: u64) -> bool {
    let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs(),
        Err(_) => return false,
    };

    now.checked_sub(checked_at)
        .is_some_and(|age| age < 12 * 60 * 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tempfile::tempdir;

    fn unix_secs(time: SystemTime) -> u64 {
        time.duration_since(UNIX_EPOCH).unwrap().as_secs()
    }

    #[test]
    fn reads_fresh_update_notice_cache() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("notice.json");
        let checked_at = unix_secs(SystemTime::now() - Duration::from_secs(60));
        let json = serde_json::json!({
            "checked_at": checked_at,
            "notices": [
                {
                    "package_name": "@scope/plugin-a",
                    "latest_version": "2.0.0",
                    "installed_version": "1.0.0",
                    "declared_open_code_range": ">=1.15.0"
                },
                {
                    "package_name": "plugin-b",
                    "latest_version": "3.1.4",
                    "installed_version": null
                }
            ]
        });

        fs::write(&path, serde_json::to_string(&json).unwrap()).unwrap();

        let cache = read_update_notice_cache_from_path(&path);

        assert!(cache.is_some());
        let cache = cache.unwrap();
        assert_eq!(cache.checked_at, checked_at);
        assert_eq!(cache.notices.len(), 2);
        assert_eq!(cache.notices[0].package_name, "@scope/plugin-a");
        assert_eq!(cache.notices[0].latest_version, "2.0.0");
        assert_eq!(cache.notices[0].installed_version.as_deref(), Some("1.0.0"));
        assert_eq!(
            cache.notices[0].declared_open_code_range.as_deref(),
            Some(">=1.15.0")
        );
        assert_eq!(cache.notices[1].installed_version, None);
        assert!(cache.notices[1].declared_open_code_range.is_none());
    }

    #[test]
    fn ignores_stale_update_notice_cache() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("notice.json");
        let checked_at = unix_secs(SystemTime::now() - Duration::from_secs(13 * 60 * 60));
        let json = serde_json::json!({
            "checked_at": checked_at,
            "notices": [
                {
                    "package_name": "plugin-a",
                    "latest_version": "2.0.0",
                    "installed_version": "1.0.0"
                }
            ]
        });

        fs::write(&path, serde_json::to_string(&json).unwrap()).unwrap();

        assert!(read_update_notice_cache_from_path(&path).is_none());
    }

    #[test]
    fn round_trip_write_and_read_cache() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("notice.json");
        let cache = UpdateNoticeCache {
            checked_at: unix_secs(SystemTime::now() - Duration::from_secs(60)),
            notices: vec![
                UpdateNotice {
                    package_name: "@scope/plugin-a".to_string(),
                    latest_version: "2.0.0".to_string(),
                    installed_version: Some("1.0.0".to_string()),
                    declared_open_code_range: Some(">=1.15.0".to_string()),
                },
                UpdateNotice {
                    package_name: "plugin-b".to_string(),
                    latest_version: "3.1.4".to_string(),
                    installed_version: None,
                    declared_open_code_range: None,
                },
            ],
            cli_latest_version: None,
        };

        write_cache_to_path(&cache, &path).unwrap();

        let read_back = read_update_notice_cache_from_path(&path).unwrap();
        assert_eq!(read_back.checked_at, cache.checked_at);
        assert_eq!(read_back.notices.len(), 2);
        assert_eq!(
            read_back.notices[0].package_name,
            cache.notices[0].package_name
        );
        assert_eq!(
            read_back.notices[0].latest_version,
            cache.notices[0].latest_version
        );
        assert_eq!(
            read_back.notices[0].installed_version,
            cache.notices[0].installed_version
        );
        assert_eq!(
            read_back.notices[0].declared_open_code_range,
            cache.notices[0].declared_open_code_range
        );
        assert_eq!(
            read_back.notices[1].installed_version,
            cache.notices[1].installed_version
        );
        assert!(read_back.notices[1].declared_open_code_range.is_none());
    }

    #[test]
    fn write_cache_creates_parent_directory() {
        let dir = tempdir().unwrap();
        let deep_path = dir
            .path()
            .join("nonexistent")
            .join("sub")
            .join("notice.json");
        let cache = UpdateNoticeCache {
            checked_at: unix_secs(SystemTime::now() - Duration::from_secs(60)),
            notices: vec![UpdateNotice {
                package_name: "test".to_string(),
                latest_version: "1.0.0".to_string(),
                installed_version: None,
                declared_open_code_range: None,
            }],
            cli_latest_version: None,
        };

        // Should succeed even though parent dirs don't exist
        write_cache_to_path(&cache, &deep_path).unwrap();
        assert!(deep_path.exists());

        // Verify contents can be read back
        let read_back = read_update_notice_cache_from_path(&deep_path).unwrap();
        assert_eq!(read_back.notices[0].package_name, "test");
    }

    #[test]
    fn ignores_missing_or_malformed_cache() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("notice.json");

        assert!(read_update_notice_cache_from_path(&path).is_none());

        fs::write(&path, "not json").unwrap();

        assert!(read_update_notice_cache_from_path(&path).is_none());
    }

    #[test]
    fn outdated_count_counts_only_truly_outdated_notices() {
        let cache = UpdateNoticeCache {
            checked_at: 0,
            notices: vec![
                // Truly outdated: installed=1.0.0, latest=2.0.0
                UpdateNotice {
                    package_name: "plugin-a".to_string(),
                    latest_version: "2.0.0".to_string(),
                    installed_version: Some("1.0.0".to_string()),
                    declared_open_code_range: None,
                },
                // Not outdated: installed matches latest
                UpdateNotice {
                    package_name: "plugin-b".to_string(),
                    latest_version: "1.0.0".to_string(),
                    installed_version: Some("1.0.0".to_string()),
                    declared_open_code_range: None,
                },
                // Not outdated: no installed_version
                UpdateNotice {
                    package_name: "plugin-c".to_string(),
                    latest_version: "3.0.0".to_string(),
                    installed_version: None,
                    declared_open_code_range: None,
                },
            ],
            cli_latest_version: None,
        };

        assert_eq!(cache.outdated_count(), 1);
    }

    #[test]
    fn outdated_count_zero_when_all_installed_match_latest() {
        let cache = UpdateNoticeCache {
            checked_at: 0,
            notices: vec![
                UpdateNotice {
                    package_name: "a".to_string(),
                    latest_version: "1.0.0".to_string(),
                    installed_version: Some("1.0.0".to_string()),
                    declared_open_code_range: None,
                },
                UpdateNotice {
                    package_name: "b".to_string(),
                    latest_version: "2.0.0".to_string(),
                    installed_version: Some("2.0.0".to_string()),
                    declared_open_code_range: None,
                },
            ],
            cli_latest_version: None,
        };

        assert_eq!(cache.outdated_count(), 0);
    }

    #[test]
    fn outdated_count_zero_when_empty() {
        let cache = UpdateNoticeCache {
            checked_at: 0,
            notices: vec![],
            cli_latest_version: None,
        };

        assert_eq!(cache.outdated_count(), 0);
    }

    #[test]
    fn deserializes_cache_without_cli_latest_version() {
        let json = serde_json::json!({
            "checked_at": 1000000,
            "notices": [
                {
                    "package_name": "test",
                    "latest_version": "1.0.0",
                    "installed_version": null
                }
            ]
        });
        let cache: UpdateNoticeCache = serde_json::from_value(json).unwrap();
        assert_eq!(cache.cli_latest_version, None);
        assert_eq!(cache.notices.len(), 1);
    }

    #[test]
    fn round_trip_cli_latest_version() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("notice.json");
        let now = unix_secs(SystemTime::now() - Duration::from_secs(60));
        let mut cache = UpdateNoticeCache {
            checked_at: now,
            notices: vec![],
            cli_latest_version: Some("2.0.0".to_string()),
        };

        write_cache_to_path(&cache, &path).unwrap();

        let read_back = read_update_notice_cache_from_path(&path).unwrap();
        assert_eq!(read_back.cli_latest_version.as_deref(), Some("2.0.0"));
        assert_eq!(read_back.checked_at, now);

        // Also verify it round-trips as None
        cache.cli_latest_version = None;
        write_cache_to_path(&cache, &path).unwrap();
        let read_back = read_update_notice_cache_from_path(&path).unwrap();
        assert!(read_back.cli_latest_version.is_none());
    }
}
