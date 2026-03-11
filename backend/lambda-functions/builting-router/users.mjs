import { dynamo, GetCommand } from './db.mjs';

const TableName = process.env.USERS_TABLE || 'builting-users';

const users = {
  handle: async (event) => {
    const method = event.requestContext?.http?.method || event.httpMethod || '';

    if (method === 'GET') {
      const requestedId = event.pathParameters?.id;
      if (!requestedId) return { error: 'Missing user id', statusCode: 400 };

      // Users can only fetch their own record
      if (requestedId !== event._authenticatedUserId) {
        return { error: 'Not authenticated', statusCode: 401 };
      }

      return await users.getUser(requestedId);
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
