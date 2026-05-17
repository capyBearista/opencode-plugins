mod cli;
mod doctor;
mod config;
mod errors;
mod output;
mod catalog;
mod discovery;
mod registry;

use clap::Parser;
use cli::{Cli, Commands};
use config::parser::{GlobalConfigProvider, ProjectConfigProvider};
use config::provider::{ConfigProvider, PluginEntry};
use discovery::{deduplicate_plugins, enrich_plugin, resolve_plugins, EnrichedPlugin};
use errors::CliError;
use registry::cache::read_update_notice_cache;
use std::env;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    if let Some(cache) = read_update_notice_cache() {
        if should_show_startup_notice(cli.json, cli.quiet, cache.notices.len()) {
            println!(
                "Note: {} plugin updates available. Run `oc-plugins outdated` for details.",
                cache.notices.len()
            );
        }
    }

    match &cli.command {
        Commands::List { project, global } => {
            let enriched_plugins = load_enriched_plugins(cli.json, *project, *global)?;

            if cli.json {
                output::json::print_plugins_json(&enriched_plugins);
            } else {
                output::human::print_plugins(&enriched_plugins);
            }
        }
        Commands::Doctor { project, global } => {
            let enriched_plugins = load_enriched_plugins(cli.json, *project, *global)?;
            let reports = doctor::build_doctor_reports(&enriched_plugins);

            if cli.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&doctor::build_doctor_output(&enriched_plugins))
                        .unwrap()
                );
            } else {
                doctor::print_doctor_reports(&reports);
            }
        }
        Commands::Outdated { project, global, refresh } => {
            println!("Outdated command (project: {}, global: {}, refresh: {})", project, global, refresh);
        }
        Commands::Add { plugin, project, global, yes, dry_run } => {
            println!("Add command (plugin: {}, project: {}, global: {}, yes: {}, dry_run: {})", plugin, project, global, yes, dry_run);
        }
        Commands::Update { plugin, project, global, yes, dry_run, refresh } => {
            println!("Update command (plugin: {:?}, project: {}, global: {}, yes: {}, dry_run: {}, refresh: {})", plugin, project, global, yes, dry_run, refresh);
        }
        Commands::Remove { plugin, project, global, yes, dry_run } => {
            println!("Remove command (plugin: {}, project: {}, global: {}, yes: {}, dry_run: {})", plugin, project, global, yes, dry_run);
        }
    }

    Ok(())
}

fn should_show_startup_notice(json: bool, quiet: bool, notice_count: usize) -> bool {
    !json && !quiet && notice_count > 0
}

fn load_enriched_plugins(json: bool, project: bool, global: bool) -> anyhow::Result<Vec<EnrichedPlugin>> {
    let all_plugins = collect_configured_plugins(json, project, global)?;
    let deduplicated = deduplicate_plugins(all_plugins);
    Ok(resolve_plugins(deduplicated)
        .into_iter()
        .map(enrich_plugin)
        .collect())
}

fn collect_configured_plugins(json: bool, project: bool, global: bool) -> anyhow::Result<Vec<PluginEntry>> {
    let mut all_plugins = Vec::new();

    let show_project = project || (!project && !global);
    let show_global = global || (!project && !global);

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

fn handle_config_error(
    json: bool,
    scope: &str,
    error: CliError,
) -> ! {
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
}
