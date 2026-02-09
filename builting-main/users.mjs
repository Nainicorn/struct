import { dynamo, GetCommand } from './db.mjs';

const TableName = 'builting-users';

const users = {
  handle: async (event) => {
    if (event.httpMethod === 'GET') {
      // Extract user id from path: /dev/api/users/{id} or /api/users/{id}
      const path = event.path || event.rawPath || '';
      const pathParts = path.split('/').filter(p => p); // Remove empty parts
      const userId = pathParts[pathParts.length - 1]; // Get last part

      if (!userId || userId === 'users') return { error: 'Missing user id', statusCode: 400 };
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

      // Return user data without password
      const { password, ...user } = data.Item;
      return user;
    } catch (error) {
      console.error('Error getting user:', error);
      return { error: 'Failed to get user', statusCode: 500 };
    }
  }
};

export default users;
