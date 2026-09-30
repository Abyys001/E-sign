/** next-intl treats "." as nesting, so dotted event/notification identifiers map to underscore keys. */
export const ek = (s: string) => s.replace(/\./g, "_");
