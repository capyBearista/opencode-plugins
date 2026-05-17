use crate::config::provider::PluginEntry;
use serde::Serialize;

#[derive(Serialize)]
pub struct JsonOutput {
    pub scope: String,
    pub config_path: String,
    pub plugins: Vec<JsonPlugin>,
}

#[derive(Serialize)]
pub struct JsonPlugin {
    pub name: String,
    pub requested: String,
    pub scope: String,
}

pub fn print_plugins_json(plugins: &[PluginEntry]) {
    let mut json_plugins = Vec::new();
    for plugin in plugins {
        json_plugins.push(JsonPlugin {
            name: plugin.spec.clone(), // We will resolve canonical name later
            requested: plugin.spec.clone(),
            scope: match plugin.scope {
                crate::config::provider::ConfigScope::Project => "project".to_string(),
                crate::config::provider::ConfigScope::Global => "global".to_string(),
            },
        });
    }

    let output = JsonOutput {
        scope: "mixed".to_string(),
        config_path: "mixed".to_string(),
        plugins: json_plugins,
    };

    if let Ok(json) = serde_json::to_string_pretty(&output) {
        println!("{}", json);
    }
}
