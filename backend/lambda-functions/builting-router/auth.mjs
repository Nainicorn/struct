import { dynamo, PutCommand, GetCommand, QueryCommand } from './db.mjs';
import { randomUUID, scrypt, randomBytes, timingSafeEqual, createHmac } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);
const TableName = process.env.USERS_TABLE || 'builting-users';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-in-production';

// --- Password hashing (scrypt, FIPS-compatible, zero deps) ---

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;
  const derived = await scryptAsync(password, salt, 64);
  return timingSafeEqual(Buffer.from(hash, 'hex'), derived);
}

// --- Signed token: userId.timestamp.hmac ---

function createToken(userId) {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${userId}.${timestamp}`;
  const hmac = createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${hmac}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, timestamp, hmac] = parts;
  if (!userId || !timestamp || !hmac) return null;
  const expectedHmac = createHmac('sha256', SESSION_SECRET).update(`${userId}.${timestamp}`).digest('hex');
  if (hmac.length !== expectedHmac.length) return null;
  if (!timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(expectedHmac, 'hex'))) return null;
  return userId;
}

// --- Token extraction + verification ---

export function getUserIdFromCookies(event) {
  // Check Authorization header first (cross-origin can't rely on cookies)
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const userId = verifyToken(token);
    if (userId) return userId;
    console.log('Auth: invalid Bearer token');
    return null;
  }

  // Fallback to cookie (same-origin deployments)
  const h = event.headers?.cookie || event.headers?.Cookie || '';
  for (let c of h.split(';')) {
    c = c.trim();
    if (c.startsWith('builting-user=')) {
      const tokenValue = decodeURIComponent(c.substring('builting-user='.length));
      const userId = verifyToken(tokenValue);
      if (!userId) {
        console.log('Auth: invalid or malformed token');
        return null;
      }
      return userId;
    }
  }
  console.log('Auth: no auth token found');
  return null;
}

const auth = {
  handle: async (event) => {
    // Handle both REST API (httpMethod) and HTTP API (requestContext.http.method) formats
    const method = event.requestContext?.http?.method || event.httpMethod || '';

    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (body.action === 'login') return auth.login(event.body);
      return { error: 'Invalid action', statusCode: 400 };
    }

    if (method === 'GET') return auth.validate(event);

    return { error: 'Invalid method', statusCode: 400 };
  },

  login: async (body) => {
    const { email, password } = JSON.parse(body || '{}');

    const data = await dynamo.send(new QueryCommand({
      TableName,
      IndexName: 'email-index',
      KeyConditionExpression: 'email = :e',
      ExpressionAttributeValues: { ':e': email }
    }));

    const user = data.Items?.[0];
    if (!user) return { error: 'Invalid credentials', statusCode: 401 };

    const valid = await verifyPassword(password, user.password);
    if (!valid) return { error: 'Invalid credentials', statusCode: 401 };

    return { user: { id: user.id, email: user.email, name: user.name }, token: createToken(user.id) };
  },

  validate: async (event) => {
    const userId = getUserIdFromCookies(event);
    if (!userId) return { error: 'Not authenticated', statusCode: 401 };

    const data = await dynamo.send(new GetCommand({ TableName, Key: { id: userId } }));
    if (!data.Item) return { error: 'Not found', statusCode: 401 };

    return { id: data.Item.id, email: data.Item.email, name: data.Item.name };
  }
};

export default auth;
