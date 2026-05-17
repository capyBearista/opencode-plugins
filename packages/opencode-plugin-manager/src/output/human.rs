use crate::config::provider::PluginEntry;
use colored::*;

pub fn print_plugins(plugins: &[PluginEntry]) {
    if plugins.is_empty() {
        println!("No configured plugins found.");
        return;
    }

    println!("{}", "Configured OpenCode plugins".bold());
    println!();

    let mut project_plugins = Vec::new();
    let mut global_plugins = Vec::new();

    for plugin in plugins {
        match plugin.scope {
            crate::config::provider::ConfigScope::Project => project_plugins.push(plugin),
            crate::config::provider::ConfigScope::Global => global_plugins.push(plugin),
        }
    }

    if !project_plugins.is_empty() {
        println!("{}", "Project".bold());
        for plugin in project_plugins {
            println!("  {}", plugin.spec.cyan());
            println!(
                "  configured in: {}",
                plugin.config_path.display().to_string().dimmed()
            );
            println!();
        }
    }

    if !global_plugins.is_empty() {
        println!("{}", "Global".bold());
        for plugin in global_plugins {
            println!("  {}", plugin.spec.cyan());
            println!(
                "  configured in: {}",
                plugin.config_path.display().to_string().dimmed()
            );
            println!();
        }
    }
}
