import { dynamo, PutCommand, GetCommand, QueryCommand } from './db.mjs';
import { randomUUID } from 'crypto';

const TableName = 'builting-users';

export function getUserIdFromCookies(event) {
  let h = event.headers?.cookie || event.headers?.Cookie || '';
  console.log('Cookie header:', h);
  console.log('All event headers:', Object.keys(event.headers || {}));
  for (let c of h.split(';')) {
    c = c.trim();
    if (c.startsWith('builting-user=')) {
      const userJson = decodeURIComponent(c.split('=')[1]);
      const user = JSON.parse(userJson);
      console.log('User ID extracted:', user.id);
      return user.id;
    }
  }
  console.log('No builting-user cookie found');
  return null;
}

const auth = {
  handle: async (event) => {
    // Handle both REST API (httpMethod) and HTTP API (requestContext.http.method) formats
    const method = event.requestContext?.http?.method || event.httpMethod || '';

    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (body.action === 'login') return auth.login(event.body);
      if (body.action === 'signup') return auth.signup(event.body);
      return { error: 'Invalid action', statusCode: 400 };
    }

    if (method === 'GET') return auth.validate(event);

    return { error: 'Invalid method', statusCode: 400 };
  },

  signup: async (body) => {
    const { email, password, name } = JSON.parse(body || '{}');
    if (!email || !password || !name) return { error: 'Missing fields', statusCode: 400 };

    const existing = await dynamo.send(new QueryCommand({
      TableName,
      IndexName: 'email-index',
      KeyConditionExpression: 'email = :e',
      ExpressionAttributeValues: { ':e': email }
    }));

    if (existing.Items?.length) return { error: 'User exists', statusCode: 409 };

    const id = randomUUID();
    await dynamo.send(new PutCommand({
      TableName,
      Item: { id, email, password, name, created_at: Date.now() }
    }));

    return { user: { id, email, name } };
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
    if (!user) return { error: 'Not found', statusCode: 401 };

    // (Optional) verify password here
    // if (user.password !== password) return { error: 'Invalid credentials', statusCode: 401 };

    return { user: { id: user.id, email: user.email, name: user.name } };
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
