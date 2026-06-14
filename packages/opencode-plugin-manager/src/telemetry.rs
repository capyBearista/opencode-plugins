//! Privacy-light telemetry.
//!
//! Collects only aggregate operational data: command name, success/failure,
//! duration bucket, tool version. No identity, path, IP, or fingerprint data.
//!
//! **Opt-out**: set `DISABLE_TELEMETRY`, `DO_NOT_TRACK`, or `CI` to any
//! non-empty value. Also implicitly disabled in `--json` or `--quiet` mode
//! to preserve machine/script discipline.
//!
//! Telemetry is flushed with a short timeout after command execution; failures
//! are silently ignored.

use serde::Serialize;
use std::time::Duration;

/// Duration bucket labels used for aggregate latency analysis.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurationBucket {
    Fast,     // < 1 second
    Moderate, // 1–5 seconds
    Slow,     // 5–30 seconds
    VerySlow, // >= 30 seconds
}

impl DurationBucket {
    pub fn as_str(&self) -> &'static str {
        match self {
            DurationBucket::Fast => "fast",
            DurationBucket::Moderate => "moderate",
            DurationBucket::Slow => "slow",
            DurationBucket::VerySlow => "very_slow",
        }
    }
}

/// Compute the duration bucket for a given elapsed time.
pub fn classify_duration(d: Duration) -> DurationBucket {
    let secs = d.as_secs_f64();
    if secs < 1.0 {
        DurationBucket::Fast
    } else if secs < 5.0 {
        DurationBucket::Moderate
    } else if secs < 30.0 {
        DurationBucket::Slow
    } else {
        DurationBucket::VerySlow
    }
}

/// Aggregate operational data sent to the telemetry endpoint.
#[derive(Debug, Serialize)]
pub struct TelemetryPayload {
    pub event: String,
    pub command: String,
    pub success: bool,
    pub duration_bucket: &'static str,
    pub tool_version: &'static str,
    /// Optional extra fields (e.g. package_count, notice_count, alias_used).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_notice_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias_used: Option<bool>,
}

/// Returns `true` if telemetry should be suppressed in the current environment.
pub fn should_opt_out(json: bool, quiet: bool) -> bool {
    // Explicit env-var opt-out
    if std::env::var_os("DISABLE_TELEMETRY").is_some_and(|v| !v.is_empty())
        || std::env::var_os("DO_NOT_TRACK").is_some_and(|v| !v.is_empty())
        || std::env::var_os("CI").is_some_and(|v| !v.is_empty())
    {
        return true;
    }
    // Suppress in script/machine modes
    json || quiet
}

/// The default telemetry endpoint URL.
///
/// Override via `OC_PLUGINS_TELEMETRY_URL` env var.  When empty (the default
/// compiled-in value or an explicit empty override), sending is skipped
/// entirely — effectively a compile-time no-op until a URL is configured.
pub fn telemetry_endpoint() -> Option<String> {
    let url = std::env::var("OC_PLUGINS_TELEMETRY_URL").unwrap_or_default();
    if url.is_empty() { None } else { Some(url) }
}

/// Bounded telemetry send.
///
/// Builds the payload from the provided values, checks opt-out gating,
/// and sends an HTTP POST with a short timeout at process exit. Failures
/// (network, timeout, serialization) are silently discarded.
#[allow(clippy::too_many_arguments)]
pub async fn record_command(
    command: &str,
    success: bool,
    duration: Duration,
    package_count: Option<usize>,
    update_notice_count: Option<usize>,
    alias_used: Option<bool>,
    json: bool,
    quiet: bool,
) {
    // Opt-out gate
    if should_opt_out(json, quiet) {
        return;
    }

    // No configured endpoint — skip
    let Some(url) = telemetry_endpoint() else {
        return;
    };

    let payload = TelemetryPayload {
        event: "command".to_string(),
        command: command.to_string(),
        success,
        duration_bucket: classify_duration(duration).as_str(),
        tool_version: env!("CARGO_PKG_VERSION"),
        package_count,
        update_notice_count,
        alias_used,
    };

    let body = match serde_json::to_string(&payload) {
        Ok(body) => body,
        Err(_) => return,
    };
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
    {
        Ok(client) => client,
        Err(_) => return,
    };
    let _ = client
        .post(&url)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Opt-out gating ---

    #[test]
    fn opt_out_when_disable_telemetry_set() {
        unsafe { std::env::set_var("DISABLE_TELEMETRY", "1") };
        assert!(should_opt_out(false, false));
        unsafe { std::env::remove_var("DISABLE_TELEMETRY") };
    }

    #[test]
    fn opt_out_when_do_not_track_set() {
        unsafe { std::env::set_var("DO_NOT_TRACK", "1") };
        assert!(should_opt_out(false, false));
        unsafe { std::env::remove_var("DO_NOT_TRACK") };
    }

    #[test]
    fn opt_out_when_ci_set() {
        unsafe { std::env::set_var("CI", "true") };
        assert!(should_opt_out(false, false));
        unsafe { std::env::remove_var("CI") };
    }

    #[test]
    fn opt_out_when_json_or_quiet() {
        assert!(should_opt_out(true, false));
        assert!(should_opt_out(false, true));
        assert!(should_opt_out(true, true));
    }

    #[test]
    fn not_opted_out_by_default() {
        // Without any env vars, not json/quiet, should return false
        // Save and restore env to avoid flakiness
        let disable = std::env::var_os("DISABLE_TELEMETRY");
        let dnt = std::env::var_os("DO_NOT_TRACK");
        let ci = std::env::var_os("CI");
        unsafe {
            std::env::remove_var("DISABLE_TELEMETRY");
            std::env::remove_var("DO_NOT_TRACK");
            std::env::remove_var("CI");
        }
        assert!(!should_opt_out(false, false));
        // Restore
        if let Some(v) = disable {
            unsafe {
                std::env::set_var("DISABLE_TELEMETRY", v);
            }
        }
        if let Some(v) = dnt {
            unsafe {
                std::env::set_var("DO_NOT_TRACK", v);
            }
        }
        if let Some(v) = ci {
            unsafe {
                std::env::set_var("CI", v);
            }
        }
    }

    #[test]
    fn does_not_opt_out_when_env_var_is_empty() {
        let prev = std::env::var_os("DISABLE_TELEMETRY");
        unsafe { std::env::set_var("DISABLE_TELEMETRY", "") };
        // Should NOT opt out when the var is set to empty string
        assert!(!should_opt_out(false, false));
        if let Some(v) = prev {
            unsafe {
                std::env::set_var("DISABLE_TELEMETRY", v);
            }
        } else {
            unsafe {
                std::env::remove_var("DISABLE_TELEMETRY");
            }
        }
    }

    // --- Duration buckets ---

    #[test]
    fn duration_bucket_fast() {
        assert_eq!(
            classify_duration(Duration::from_millis(500)),
            DurationBucket::Fast
        );
        assert_eq!(
            classify_duration(Duration::from_millis(999)),
            DurationBucket::Fast
        );
    }

    #[test]
    fn duration_bucket_moderate() {
        assert_eq!(
            classify_duration(Duration::from_secs(1)),
            DurationBucket::Moderate
        );
        assert_eq!(
            classify_duration(Duration::from_secs(4)),
            DurationBucket::Moderate
        );
    }

    #[test]
    fn duration_bucket_slow() {
        assert_eq!(
            classify_duration(Duration::from_secs(5)),
            DurationBucket::Slow
        );
        assert_eq!(
            classify_duration(Duration::from_secs(29)),
            DurationBucket::Slow
        );
    }

    #[test]
    fn duration_bucket_very_slow() {
        assert_eq!(
            classify_duration(Duration::from_secs(30)),
            DurationBucket::VerySlow
        );
        assert_eq!(
            classify_duration(Duration::from_secs(300)),
            DurationBucket::VerySlow
        );
    }

    #[test]
    fn duration_bucket_str_labels() {
        assert_eq!(DurationBucket::Fast.as_str(), "fast");
        assert_eq!(DurationBucket::Moderate.as_str(), "moderate");
        assert_eq!(DurationBucket::Slow.as_str(), "slow");
        assert_eq!(DurationBucket::VerySlow.as_str(), "very_slow");
    }

    // --- Payload shape ---

    #[test]
    fn payload_serializes_correctly() {
        let payload = TelemetryPayload {
            event: "command".to_string(),
            command: "list".to_string(),
            success: true,
            duration_bucket: "fast",
            tool_version: "1.0.0",
            package_count: Some(5),
            update_notice_count: Some(2),
            alias_used: Some(false),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["event"], "command");
        assert_eq!(json["command"], "list");
        assert_eq!(json["success"], true);
        assert_eq!(json["duration_bucket"], "fast");
        assert_eq!(json["tool_version"], "1.0.0");
        assert_eq!(json["package_count"], 5);
        assert_eq!(json["update_notice_count"], 2);
        assert_eq!(json["alias_used"], false);
    }

    #[test]
    fn payload_skips_optional_fields_when_none() {
        let payload = TelemetryPayload {
            event: "command".to_string(),
            command: "outdated".to_string(),
            success: true,
            duration_bucket: "moderate",
            tool_version: "1.0.0",
            package_count: None,
            update_notice_count: None,
            alias_used: None,
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert!(json.get("package_count").is_none());
        assert!(json.get("update_notice_count").is_none());
        assert!(json.get("alias_used").is_none());
    }

    // --- Telemetry endpoint ---

    #[test]
    fn endpoint_defaults_to_none() {
        let prev = std::env::var_os("OC_PLUGINS_TELEMETRY_URL");
        unsafe { std::env::remove_var("OC_PLUGINS_TELEMETRY_URL") };
        assert!(telemetry_endpoint().is_none());
        if let Some(v) = prev {
            unsafe {
                std::env::set_var("OC_PLUGINS_TELEMETRY_URL", v);
            }
        }
    }

    #[test]
    fn endpoint_from_env_var() {
        let prev = std::env::var_os("OC_PLUGINS_TELEMETRY_URL");
        unsafe { std::env::set_var("OC_PLUGINS_TELEMETRY_URL", "https://example.com/telemetry") };
        assert_eq!(
            telemetry_endpoint().as_deref(),
            Some("https://example.com/telemetry")
        );
        if let Some(v) = prev {
            unsafe {
                std::env::set_var("OC_PLUGINS_TELEMETRY_URL", v);
            }
        } else {
            unsafe {
                std::env::remove_var("OC_PLUGINS_TELEMETRY_URL");
            }
        }
    }
}
