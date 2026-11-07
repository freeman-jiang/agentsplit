// A module of its own: route loaders in the main chunk use it, and the date
// groups of the expense list must not move into that chunk with it.

/** The calendar date of `when` where the viewer is; today by default. */
export function localDate(when = new Date()) {
  return `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`
}
