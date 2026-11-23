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
  // The address itself looks like a link (underline + link colour); the whole label is the click target.
  const at = fitted.lastIndexOf(supportAddress);
  const styled = theme.enabled && at >= 0
    ? `${fitted.slice(0, at)}${theme.underline}${theme.sky}${supportAddress}${theme.reset}${theme.amber}${fitted.slice(at + supportAddress.length)}`
    : fitted;
  return `${theme.amber}${hyperlinks ? terminalLink(styled, SUPPORT_URL) : styled}${theme.reset}`;
};
