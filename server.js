import express from 'express';
import cors from 'cors';

const app = express();
const PORT = 5002;

// Middleware
app.use(cors());
app.use(express.json());

// Mock user storage (in production, this will be DynamoDB)
const mockUsers = {
  'test@example.com': {
    id: '1',
    email: 'test@example.com',
    name: 'Test User',
    createdAt: new Date().toISOString()
  },
  'demo@example.com': {
    id: '2',
    email: 'demo@example.com',
    name: 'Demo User',
    createdAt: new Date().toISOString()
  }
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Mock API server is running' });
});

// Login endpoint
app.post('/api/login', (req, res) => {
  try {
    const { email } = req.body;

    // Validate email
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: 'Invalid email format' });
    }

    // Check if user exists, if not create a new one
    let user = mockUsers[email];
    if (!user) {
      user = {
        id: Date.now().toString(),
        email: email,
        name: email.split('@')[0],
        createdAt: new Date().toISOString()
      };
      mockUsers[email] = user;
    }

    // Return user
    res.json({ user });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Start server
app.listen(PORT, 'localhost', () => {
  console.log(`Mock API server is running on http://localhost:${PORT}`);
  console.log(`Test credentials: test@example.com or demo@example.com`);
});
