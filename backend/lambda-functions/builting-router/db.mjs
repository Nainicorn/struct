import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand
} from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
export const dynamo = DynamoDBDocumentClient.from(client);

export { GetCommand, PutCommand, QueryCommand, UpdateCommand, DeleteCommand };
