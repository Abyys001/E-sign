/** Persian when Persian/Arabic letters make up at least 30 % of the letters (mixed "Stripe fee چقدر بود" counts as Persian). */
export function detectLanguage(text: string): "en" | "fa" {
  const fa = (text.match(/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return fa > 0 && fa >= (fa + latin) * 0.3 ? "fa" : "en";
}
