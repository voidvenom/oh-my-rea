import { terminalLink, truncateAnsi, visibleWidth, type ColorTheme } from "./ansi.js";
import type { I18n } from "./i18n/index.js";

export const SUPPORT_URL = "https://buymeacoffee.com/omrdev";
const supportAddress = SUPPORT_URL.slice("https://".length);

export const renderSupportLine = (
  width: number,
  i18n: I18n,
  theme: ColorTheme,
  hyperlinks: boolean,
): string => {
  const label = i18n.t("support.cta", { url: supportAddress }) || `☕ ${supportAddress}`;
  const fitted = visibleWidth(label) <= width ? label : truncateAnsi(supportAddress, width);
  if (!fitted) return "";
  return `${theme.amber}${hyperlinks ? terminalLink(fitted, SUPPORT_URL) : fitted}${theme.reset}`;
};
