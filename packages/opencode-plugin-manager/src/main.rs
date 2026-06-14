mod catalog;
mod cli;
mod commands;
mod config;
mod discovery;
mod errors;
mod output;
mod registry;
mod safety;
mod version_util;

use clap::Parser;
use cli::{Cli, Commands};
use config::parser::{GlobalConfigProvider, ProjectConfigProvider};
use config::provider::{ConfigProvider, PluginEntry};
use discovery::{
    EnrichedPlugin, PluginStatus, classify_plugins, deduplicate_plugins, enrich_plugin,
    enrich_with_latest_versions, resolve_plugins,
};
use errors::CliError;
use registry::cache::{UpdateNoticeCache, default_notice_cache_path, read_update_notice_cache};
use registry::client::{DEFAULT_MAX_CONCURRENT, RegistryClient};
use std::env;
use std::process::ExitCode;
use version_util::version_is_newer;

#[tokio::main]
async fn main() -> anyhow::Result<ExitCode> {
    let cli = Cli::parse();

    // Cache-based notices: read once and reuse for startup banners and command
    // enrichment. The cache is populated reactively during `outdated` registry
    // refresh, so startup and `list` never perform network calls.
    let notice_cache = read_update_notice_cache();
    if let Some(cache) = notice_cache.as_ref() {
        let outdated = cache.outdated_count();
        if should_show_startup_notice(cli.json, cli.quiet, outdated) {
            println!(
                "Note: {} plugin update{} available. Run `oc-plugins outdated` for details.",
                outdated,
                if outdated == 1 { "" } else { "s" },
            );
        }

        // Self-update notice: read from cache; only shown when json/quiet are
        // false, a cached update is present, and the cached version is strictly
        // newer than the currently running version (avoids stale-cache banners).
        if !cli.json
            && !cli.quiet
            && let Some(ref cli_latest) = cache.cli_latest_version
            && version_is_newer(cli_latest, env!("CARGO_PKG_VERSION"))
        {
            println!(
                "A new version of oc-plugins (v{cli_latest}) is available. \
                 Run `npm install -g @capybearista/opencode-plugin-manager` to update."
            );
        }
    }

    let mut exit_code = ExitCode::SUCCESS;

    match &cli.command {
        Commands::List { project, global } => {
            let mut enriched_plugins = load_enriched_plugins(cli.json, *project, *global)?;

            if let Some(cache) = notice_cache.as_ref() {
                enriched_plugins = enrich_with_latest_versions(enriched_plugins, cache);
            }

            if cli.json {
                output::json::print_plugins_json(&enriched_plugins);
            } else if !cli.quiet {
                if cli.verbose {
                    if let Some(cache) = notice_cache.as_ref() {
                        let age_secs = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs()
                            .saturating_sub(cache.checked_at);
                        if age_secs < 3600 {
                            println!("(cache: fresh, {}m old)", age_secs / 60);
                        } else if age_secs < 86400 {
                            println!("(cache: {}h old)", age_secs / 3600);
                        } else {
                            println!(
                                "(cache: stale, {}d old — run `outdated --refresh` to populate)",
                                age_secs / 86400
                            );
                        }
                    } else {
                        println!("(no cache — run `outdated --refresh` to populate)");
                    }
                }
                output::human::print_plugins(&enriched_plugins, cli.verbose);
            }
        }
        Commands::Outdated {
            project,
            global,
            refresh,
        } => {
            let mut enriched_plugins = load_enriched_plugins(cli.json, *project, *global)?;

            let cache_path = default_notice_cache_path();
            let cache: UpdateNoticeCache = if *refresh {
                // Explicit refresh requested — fetch live regardless.
                let client = RegistryClient::new(DEFAULT_MAX_CONCURRENT);
                client
                    .fetch_and_write_cache(&enriched_plugins, cache_path)
                    .await?
            } else if let Some(cached) = notice_cache {
                // Cache is fresh — use it without network calls.
                cached
            } else {
                // No fresh cache — fetch live.
                let client = RegistryClient::new(DEFAULT_MAX_CONCURRENT);
                client
                    .fetch_and_write_cache(&enriched_plugins, cache_path)
                    .await?
            };

            enriched_plugins = enrich_with_latest_versions(enriched_plugins, &cache);

            let classified = classify_plugins(enriched_plugins);
            let has_outdated = classified
                .iter()
                .any(|cp| cp.status == PluginStatus::Outdated);

            if cli.json {
                output::json::print_outdated_json(&classified);
            } else if !cli.quiet {
                // --quiet suppresses human output but exit status still reflects
                // the outdated check.
                output::human::print_outdated_human(&classified, cli.verbose);
            }

            if has_outdated {
                exit_code = ExitCode::from(1);
            }
        }
        Commands::Add {
            plugin,
            project,
            global,
            yes,
            dry_run,
        } => {
            return handle_mutation_result(
                commands::add::execute(plugin, *project, *global, *yes, *dry_run, cli.json),
                cli.json,
            );
        }
        Commands::Update {
            plugin,
            project,
            global,
            yes,
            dry_run,
        } => {
            return handle_mutation_result(
                commands::update::execute(
                    plugin.as_deref(),
                    *project,
                    *global,
                    *yes,
                    *dry_run,
                    cli.json,
                ),
                cli.json,
            );
        }
        Commands::Remove {
            plugin,
            project,
            global,
            yes,
            dry_run,
        } => {
            return handle_mutation_result(
                commands::remove::execute(plugin, *project, *global, *yes, *dry_run, cli.json),
                cli.json,
            );
        }
    }

    Ok(exit_code)
}

/// Execute a mutation command and handle errors according to JSON mode.
/// In JSON mode, the error is serialised as the one stdout JSON document
/// and the process exits with a failure exit code, instead of propagating
/// unstructured text via `anyhow`.
fn handle_mutation_result(
    result: Result<ExitCode, CliError>,
    json: bool,
) -> Result<ExitCode, anyhow::Error> {
    match result {
        Ok(code) => Ok(code),
        Err(e) => {
            if json {
                let error_json = serde_json::to_string_pretty(&e.to_json()).unwrap_or_else(|_| {
                    r#"{"error":"INTERNAL_ERROR","message":"serialization failed"}"#.to_string()
                });
                println!("{error_json}");
                Ok(ExitCode::FAILURE)
            } else {
                Err(anyhow::Error::from(e))
            }
        }
    }
}

fn should_show_startup_notice(json: bool, quiet: bool, outdated_count: usize) -> bool {
    !json && !quiet && outdated_count > 0
}

fn load_enriched_plugins(
    json: bool,
    project: bool,
    global: bool,
) -> anyhow::Result<Vec<EnrichedPlugin>> {
    let all_plugins = collect_configured_plugins(json, project, global)?;
    let deduplicated = deduplicate_plugins(all_plugins);
    Ok(resolve_plugins(deduplicated)?
        .into_iter()
        .map(enrich_plugin)
        .collect())
}

fn collect_configured_plugins(
    json: bool,
    project: bool,
    global: bool,
) -> anyhow::Result<Vec<PluginEntry>> {
    let mut all_plugins = Vec::new();

    let show_project = project || !global;
    let show_global = global || !project;

    if show_project {
        let cwd = env::current_dir()?;
        let project_provider = ProjectConfigProvider::new(cwd);
        match project_provider.read_plugins() {
            Ok(plugins) => all_plugins.extend(plugins),
            Err(e) => handle_config_error(json, "project", e),
        }
    }

    if show_global {
        let global_provider = GlobalConfigProvider::new();
        match global_provider.read_plugins() {
            Ok(plugins) => all_plugins.extend(plugins),
            Err(e) => handle_config_error(json, "global", e),
        }
    }

    Ok(all_plugins)
}

fn handle_config_error(json: bool, scope: &str, error: CliError) -> ! {
    // Config provider failures happen before command-specific recovery is
    // useful. Render the requested human/JSON error shape, then terminate.
    if json {
        let json_err = error.to_json();
        println!("{}", serde_json::to_string_pretty(&json_err).unwrap());
    } else {
        eprintln!("Error reading {} config: {}", scope, error);
    }

    std::process::exit(1)
}

#[cfg(test)]
mod tests {
    use super::should_show_startup_notice;

    #[test]
    fn suppresses_startup_notice_for_json_or_quiet() {
        assert!(!should_show_startup_notice(true, false, 1));
        assert!(!should_show_startup_notice(false, true, 1));
        assert!(!should_show_startup_notice(true, true, 1));
    }

    #[test]
    fn shows_startup_notice_only_when_updates_exist() {
        assert!(should_show_startup_notice(false, false, 1));
        assert!(!should_show_startup_notice(false, false, 0));
    }

    #[test]
    fn zero_outdated_suppresses_startup_notice_even_with_cache_notices() {
        // Even if the cache has notices, zero outdated should suppress the banner.
        assert!(!should_show_startup_notice(false, false, 0));
    }
}
