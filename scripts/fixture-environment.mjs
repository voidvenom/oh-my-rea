// Keep the caller's executable search path and the Windows process essentials.
// Fixtures choose which other host settings to pass to their children.
export const fixtureEnvironment = (language = "en") => ({
  PATH: process.env.PATH,
  ...(process.platform === "win32" ? {
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
  } : {}),
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  LC_MESSAGES: "C.UTF-8",
  LANGUAGE: "",
  OMR_LANG: language,
});
