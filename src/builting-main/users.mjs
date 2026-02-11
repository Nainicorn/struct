import { dynamo, GetCommand } from './db.mjs';

const TableName = 'builting-users';

const users = {
  handle: async (event) => {
    // Handle both REST API (httpMethod) and HTTP API (requestContext.http.method) formats
    const method = event.requestContext?.http?.method || event.httpMethod || '';

    if (method === 'GET') {
      const userId = event.pathParameters?.id;

      if (!userId) {
        return { error: 'Missing user id', statusCode: 400 };
      }

      return await users.getUser(userId);
    }

    return { error: 'Invalid method', statusCode: 400 };
  },

  getUser: async (userId) => {
    try {
      const data = await dynamo.send(new GetCommand({
        TableName,
        Key: { id: userId }
      }));

      if (!data.Item) return { error: 'User not found', statusCode: 404 };

      const { password, ...user } = data.Item;
      return user;
    } catch (error) {
      console.error('Error getting user:', error);
      return { error: 'Failed to get user', statusCode: 500 };
    }
  }
};

export default users;
