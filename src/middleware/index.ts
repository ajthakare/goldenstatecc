import { defineMiddleware } from 'astro:middleware';
import { hostRedirect } from './hosts';

// Send admin pages to the admin subdomain and everything else back to the
// main site (see hosts.ts). Only GET/HEAD: a 302 would turn a POST into a GET.
export const onRequest = defineMiddleware((context, next) => {
  const method = context.request.method;
  if (method === 'GET' || method === 'HEAD') {
    const target = hostRedirect(context.url);
    if (target) return context.redirect(target, 302);
  }
  return next();
});
