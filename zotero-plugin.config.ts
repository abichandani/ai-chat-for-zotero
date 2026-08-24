import { defineConfig } from "zotero-plugin-scaffold";

export default defineConfig({
  source: "addon",
  // Must match applications.zotero.id in addon/manifest.json — the reload
  // step looks up the installed add-on by this id (defaults to
  // package.json's name, which doesn't match our manifest's id).
  id: "ai-chat@hitesh.local",
  build: {
    // manifest.json is hand-maintained in addon/ — don't let the scaffold
    // regenerate/overwrite it.
    makeManifest: {
      enable: false,
    },
    // No .ftl/prefs.js files (and no TypeScript consuming them), so skip
    // generating the .d.ts files the scaffold otherwise writes to typings/.
    fluent: {
      dts: false,
    },
    prefs: {
      dts: false,
    },
  },
  server: {
    devtools: false,
  },
});
