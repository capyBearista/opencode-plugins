use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "oc-plugins")]
#[command(about = "CLI tool to manage OpenCode plugins and plugin versions", long_about = None)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,

    /// Output in JSON format
    #[arg(long, global = true)]
    pub json: bool,

    /// Suppress non-essential output
    #[arg(short, long, global = true)]
    pub quiet: bool,

    /// Show verbose output
    #[arg(short, long, global = true)]
    pub verbose: bool,
}

#[derive(Subcommand)]
pub enum Commands {
    /// List configured OpenCode plugins
    List {
        /// Show only project plugins
        #[arg(long)]
        project: bool,

        /// Show only global plugins
        #[arg(long)]
        global: bool,
    },
    /// Validate configured npm plugin health
    Doctor {
        /// Check only project plugins
        #[arg(long)]
        project: bool,

        /// Check only global plugins
        #[arg(long)]
        global: bool,
    },
    /// Compare configured plugins against npm latest
    Outdated {
        /// Check only project plugins
        #[arg(long)]
        project: bool,

        /// Check only global plugins
        #[arg(long)]
        global: bool,

        /// Force refresh of cached registry data
        #[arg(long)]
        refresh: bool,
    },
    /// Add a supported npm plugin spec to OpenCode config
    Add {
        /// The plugin package name or alias
        plugin: String,

        /// Add to project config
        #[arg(long)]
        project: bool,

        /// Add to global config
        #[arg(long)]
        global: bool,

        /// Skip confirmation
        #[arg(short, long)]
        yes: bool,

        /// Preview changes without applying
        #[arg(long)]
        dry_run: bool,
    },
    /// Update one or all configured plugins
    Update {
        /// The plugin package name or alias (optional)
        plugin: Option<String>,

        /// Update in project config
        #[arg(long)]
        project: bool,

        /// Update in global config
        #[arg(long)]
        global: bool,

        /// Skip confirmation
        #[arg(short, long)]
        yes: bool,

        /// Preview changes without applying
        #[arg(long)]
        dry_run: bool,

        /// Force refresh of cached registry data
        #[arg(long)]
        refresh: bool,
    },
    /// Remove a configured npm plugin entry from config
    Remove {
        /// The plugin package name or alias
        plugin: String,

        /// Remove from project config
        #[arg(long)]
        project: bool,

        /// Remove from global config
        #[arg(long)]
        global: bool,

        /// Skip confirmation
        #[arg(short, long)]
        yes: bool,

        /// Preview changes without applying
        #[arg(long)]
        dry_run: bool,
    },
}
