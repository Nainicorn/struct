import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient, PutCommand, GetCommand, DeleteCommand,
  QueryCommand, UpdateCommand, BatchWriteCommand
} from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(client);

export {
  dynamo, PutCommand, GetCommand, DeleteCommand,
  QueryCommand, UpdateCommand, BatchWriteCommand
};
