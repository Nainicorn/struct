import { dynamo, PutCommand, GetCommand, QueryCommand } from './db.mjs';
import { randomUUID } from 'crypto';
const TableName = 'builting-users';

export function getUserIdFromCookies(event) {
  let h = event.headers?.cookie || event.headers?.Cookie || '';
  for (let c of h.split(';')) {
    c = c.trim();
    if (c.startsWith('__app-userid=')) return c.split('=')[1];
  }
  return null;
}

const auth = {
  handle: async (event) => {
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (body.action === 'login') return auth.login(event.body);
      if (body.action === 'signup') return auth.signup(event.body);
      return { error: 'Invalid action', statusCode: 400 };
    }
    if (event.httpMethod === 'GET') return auth.validate(event);
    return { error: 'Invalid method', statusCode: 400 };
  },

  signup: async (body) => {
    let { email, password, name } = JSON.parse(body);
    if (!email || !password || !name) return { error: 'Missing fields', statusCode: 400 };

    let existing = await dynamo.send(new QueryCommand({
      TableName, IndexName: 'email-index',
      KeyConditionExpression: 'email = :e', ExpressionAttributeValues: { ':e': email }
    }));
    if (existing.Items?.length) return { error: 'User exists', statusCode: 409 };

    let id = randomUUID();
    // TODO: password = await bcrypt.hash(password, 10);
    await dynamo.send(new PutCommand({ TableName, Item: { id, email, password, name, created_at: Date.now() } }));
    return { user: { id, email, name } };
  },

  login: async (body) => {
    let { email, password } = JSON.parse(body);
    let data = await dynamo.send(new QueryCommand({
      TableName, IndexName: 'email-index',
      KeyConditionExpression: 'email = :e', ExpressionAttributeValues: { ':e': email }
    }));
    let user = data.Items?.[0];
    if (!user) return { error: 'Not found', statusCode: 401 };
    // TODO: bcrypt.compare(password, user.password)
    return { user: { id: user.id, email: user.email, name: user.name } };
  },

  validate: async (event) => {
    let userId = getUserIdFromCookies(event);
    if (!userId) return { error: 'Not authenticated', statusCode: 401 };
    let data = await dynamo.send(new GetCommand({ TableName, Key: { id: userId } }));
    if (!data.Item) return { error: 'Not found', statusCode: 401 };
    return { id: data.Item.id, email: data.Item.email, name: data.Item.name };
  }
};
export default auth;
