/**
 * Demo page fonts, bundled from npm so the page works without internet
 * access: Roboto Condensed for the UI, and the recommended editor fonts
 * (`ORACLE_EDITOR_FONTS`).
 */
import "@fontsource/roboto-condensed/400.css";
import "@fontsource/roboto-condensed/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/700.css";
import "@fontsource/cascadia-code/400.css";
import "@fontsource/cascadia-code/700.css";
import "@fontsource/source-code-pro/400.css";
import "@fontsource/source-code-pro/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/700.css";
import d2Regular from "d2coding/fonts/d2coding-ligature-full.woff2?url";
import d2Bold from "d2coding/fonts/d2coding-ligature-bold-full.woff2?url";

// The d2coding package names its ligature build plain "D2Coding"; register it as "D2Coding Ligature".
for (const [src, weight] of [[d2Regular, "400"], [d2Bold, "700"]] as const) {
  document.fonts.add(new FontFace("D2Coding Ligature", `url(${src}) format("woff2")`, { weight, display: "swap" }));
}
