import auth from './auth.mjs';
import users from './users.mjs';

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5001',
  // add prod domain here
];

export const handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  let data;
  try { data = await route(event); }
  catch (e) { console.error(e); data = { error: 'Internal server error' }; }

  let statusCode = data?.statusCode || 200;
  if (data?.statusCode) delete data.statusCode;

  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "OPTIONS,POST,GET,PUT,DELETE",
      "Access-Control-Allow-Credentials": "true",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(data)
  };
};

const route = async (event) => {
  switch (event.pathParameters.type) {
    case 'auth': return await auth.handle(event);
    case 'users': return await users.handle(event);
    default: return { error: 'Unknown type' };
  }
};
