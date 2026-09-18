import type { APIRoute } from 'astro';

export const ALL: APIRoute = async ({ redirect }) => {
  return redirect('/jobs', 301);
};
