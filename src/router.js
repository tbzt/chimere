// Hash router (#/separer, #/bibliotheque…): works on GitHub Pages without
// server rewrites. parseRoute is pure so it can be tested under Node.

export const ROUTES = ['bibliotheque', 'separer', 'mashups', 'reglages'];
export const DEFAULT_ROUTE = 'separer';

/** "#/reglages?x=1" → "reglages"; unknown or empty → DEFAULT_ROUTE. */
export function parseRoute(hash) {
  const name = String(hash ?? '')
    .replace(/^#\/?/, '')
    .split(/[/?]/)[0]
    .toLowerCase();
  return ROUTES.includes(name) ? name : DEFAULT_ROUTE;
}

/** Calls onRoute(name) now and on every hash change. Browser only. */
export function startRouter(onRoute) {
  const apply = () => onRoute(parseRoute(location.hash));
  addEventListener('hashchange', apply);
  apply();
}
