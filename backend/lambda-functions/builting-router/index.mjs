import auth, { getUserIdFromCookies } from './auth.mjs';
import users from './users.mjs';
import uploads from './uploads.mjs';
import renders from './renders.mjs';

const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://localhost:5001'];
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : DEFAULT_ORIGINS;

const corsHeaders = (origin) => ({
  "Access-Control-Allow-Headers": "Content-Type,Authorization,Cookie",
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": "OPTIONS,POST,GET,PUT,DELETE",
  "Access-Control-Allow-Credentials": "true",
  "Content-Type": "application/json",
});

export const handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  // OPTIONS preflight — always pass through, no auth
  const method = event.requestContext?.http?.method || event.httpMethod || '';
  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders(allowedOrigin),
      body: '',
    };
  }

  let data;
  try {
    data = await route(event);
  } catch (e) {
    console.error('Route error:', e);
    data = { error: 'Internal server error', statusCode: 500 };
  }

  const statusCode = data?.statusCode || 200;
  if (data?.statusCode) delete data.statusCode;

  return {
    statusCode,
    headers: corsHeaders(allowedOrigin),
    body: JSON.stringify(data ?? {}),
  };
};

// Routes that do NOT require authentication
function isPublicRoute(resource, path, method) {
  if (resource === '/api/auth' || path.includes('/api/auth')) return true;
  return false;
}

const route = async (event) => {
  const path = event.path || event.rawPath || '';
  const resource = event.resource || '';
  const method = event.requestContext?.http?.method || event.httpMethod || '';

  // Public routes — no auth required
  if (isPublicRoute(resource, path, method)) {
    if (resource === '/api/auth' || path.includes('/api/auth')) return await auth.handle(event);
  }

  // Auth gate — all other routes require a valid signed cookie
  const userId = getUserIdFromCookies(event);
  if (!userId) {
    return { error: 'Not authenticated', statusCode: 401 };
  }
  event._authenticatedUserId = userId;

  // Protected routes
  if (resource === '/api/users/{id}' || resource === '/api/users' || path.includes('/api/users')) {
    return await users.handle(event);
  }
  if (resource.includes('/uploads/presigned') || path.includes('/api/uploads')) {
    return await uploads.handle(event);
  }
  if (resource.includes('/renders') || path.includes('/api/renders')) {
    return await renders.handle(event);
  }

  return { error: 'Unknown route', statusCode: 404 };
};
