/** Where the theme switch remembers an explicit choice; absent means "follow the system". */
export const THEME_KEY = "detour-theme";

/** Runs before first paint (inline in the document head) so a remembered theme never flashes the other one. */
export const THEME_BOOT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
