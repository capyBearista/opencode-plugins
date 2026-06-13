/// Shared version comparison utilities.
///
/// All version comparisons in the codebase go through this module so
/// classify_plugins, registry/cache outdated_count, and output/human
/// latest-status labels cannot disagree.
use semver::Version;

/// Compare two version strings for semantic equality.
///
/// Parses both as semver; if both parse, uses semver equality from the
/// semver crate. Pre-release tags are significant; build metadata is ignored
/// by semver equality. If either side fails to parse, falls back to string
/// equality to avoid false negatives with non-standard version strings.
pub fn versions_equal(a: &str, b: &str) -> bool {
    match (Version::parse(a), Version::parse(b)) {
        (Ok(a_ver), Ok(b_ver)) => a_ver == b_ver,
        _ => a == b,
    }
}

/// Returns `true` iff `candidate` is a strictly newer version than `current`.
///
/// Both are parsed as semver.  If both parse, uses strict semver ordering
/// (prerelease/build metadata are significant per semver spec).  If **either**
/// side fails to parse, returns `false` — the safe default that never falsely
/// reports a newer version when we cannot be certain.
pub fn version_is_newer(candidate: &str, current: &str) -> bool {
    match (Version::parse(candidate), Version::parse(current)) {
        (Ok(candidate_ver), Ok(current_ver)) => candidate_ver > current_ver,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_equal_versions() {
        assert!(versions_equal("1.0.0", "1.0.0"));
        assert!(versions_equal("2.3.4", "2.3.4"));
    }

    #[test]
    fn semver_different_versions() {
        assert!(!versions_equal("1.0.0", "2.0.0"));
        assert!(!versions_equal("1.0.0", "1.0.1"));
    }

    #[test]
    fn fallback_to_string_when_not_semver() {
        assert!(versions_equal("latest", "latest"));
        assert!(!versions_equal("latest", "1.0.0"));
    }

    #[test]
    fn handles_pre_release_identically() {
        // semver treats pre-release parts as significant, but for our
        // purposes an exact semver match is correct.
        assert!(!versions_equal("1.0.0-alpha", "1.0.0"));
        assert!(versions_equal("1.0.0-alpha", "1.0.0-alpha"));
    }

    #[test]
    fn handles_empty_strings() {
        assert!(versions_equal("", ""));
        assert!(!versions_equal("", "1.0.0"));
    }

    // --- version_is_newer tests ---

    #[test]
    fn newer_version_detected() {
        assert!(version_is_newer("2.0.0", "1.0.0"));
        assert!(version_is_newer("1.0.1", "1.0.0"));
        assert!(version_is_newer("1.1.0", "1.0.0"));
    }

    #[test]
    fn equal_versions_not_newer() {
        assert!(!version_is_newer("1.0.0", "1.0.0"));
        assert!(!version_is_newer("2.3.4", "2.3.4"));
    }

    #[test]
    fn older_version_not_newer() {
        assert!(!version_is_newer("1.0.0", "2.0.0"));
        assert!(!version_is_newer("1.0.0", "1.0.1"));
    }

    #[test]
    fn prerelease_version_not_newer_than_release() {
        // 1.0.0-alpha is strictly less than 1.0.0 in semver
        assert!(!version_is_newer("1.0.0-alpha", "1.0.0"));
    }

    #[test]
    fn prerelease_version_can_be_newer_than_older_prerelease() {
        assert!(version_is_newer("1.0.0-beta", "1.0.0-alpha"));
    }

    #[test]
    fn unparseable_candidate_not_newer() {
        assert!(!version_is_newer("latest", "1.0.0"));
        assert!(!version_is_newer("not-a-version", "1.0.0"));
        assert!(!version_is_newer("", "1.0.0"));
    }

    #[test]
    fn unparseable_current_not_newer() {
        assert!(!version_is_newer("1.0.0", "latest"));
        assert!(!version_is_newer("1.0.0", ""));
    }

    #[test]
    fn both_unparseable_not_newer() {
        assert!(!version_is_newer("latest", "latest"));
        assert!(!version_is_newer("foo", "bar"));
        assert!(!version_is_newer("", ""));
    }
}
