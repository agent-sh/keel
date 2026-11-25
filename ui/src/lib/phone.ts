// What a phone is, said once. A phone is a window under 768 px wide, or a touch screen under 500 px
// tall: a phone turned on its side is 844 px wide and 390 px tall, and the desktop layout there
// leaves the reply no height. A tablet or a window with a mouse is taller than that and keeps the
// desktop layout. The same two queries are in ui/src/styles.css (the md and max-md variants) and in
// the media rules of the stylesheets; change them together.
export const SHORT_QUERY = "(pointer: coarse) and (max-height: 499px)";
export const PHONE_QUERY = `(max-width: 767px), ${SHORT_QUERY}`;
export const DESK_QUERY = `(min-width: 768px) and (not (${SHORT_QUERY}))`;
// A touch screen that is a phone by either measure (a media list cannot be put after `and`).
export const PHONE_TOUCH_QUERY = "(pointer: coarse) and ((max-width: 767px) or (max-height: 499px))";
