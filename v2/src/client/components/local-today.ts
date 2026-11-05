// A module of its own: route loaders in the main chunk use it, and the date
// groups of the expense list must not move into that chunk with it.

/** Today's calendar date where the viewer is, or the local date of `now`. */
export function localToday(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
