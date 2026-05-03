export default {
  async fetch() {
    const packages = [
      "@capybearista/opencode-agents-loader",
      "@capybearista/opencode-double-tap-timeline",
      "@capybearista/opencode-output-styles",
    ];
    const results = await Promise.all(
      packages.map((p) =>
        fetch(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(p)}`).then(
          (r) => r.json(),
        ),
      ),
    );
    const total = results.reduce((sum, r) => sum + r.downloads, 0);
    return new Response(
      JSON.stringify({
        schemaVersion: 1,
        label: "downloads",
        message: total.toLocaleString() + "/month",
        color: "brightgreen",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  },
};
