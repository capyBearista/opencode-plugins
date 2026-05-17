mod cli;
mod config;
mod errors;
mod output;
mod catalog;
mod discovery;

use clap::Parser;
use cli::{Cli, Commands};
use config::parser::{GlobalConfigProvider, ProjectConfigProvider};
use config::provider::ConfigProvider;
use std::env;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match &cli.command {
        Commands::List { project, global } => {
            let mut all_plugins = Vec::new();

            let show_project = *project || (!*project && !*global);
            let show_global = *global || (!*project && !*global);

            if show_project {
                if let Ok(cwd) = env::current_dir() {
                    let project_provider = ProjectConfigProvider::new(cwd);
                    if let Ok(plugins) = project_provider.read_plugins() {
                        all_plugins.extend(plugins);
                    }
                }
            }

            if show_global {
                let global_provider = GlobalConfigProvider::new();
                if let Ok(plugins) = global_provider.read_plugins() {
                    all_plugins.extend(plugins);
                }
            }

            if cli.json {
                output::json::print_plugins_json(&all_plugins);
            } else {
                output::human::print_plugins(&all_plugins);
            }
        }
        Commands::Doctor { project, global } => {
            println!("Doctor command (project: {}, global: {})", project, global);
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
