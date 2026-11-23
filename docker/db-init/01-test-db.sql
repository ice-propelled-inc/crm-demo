-- Separate database for the integration tests.
CREATE DATABASE chat_test OWNER chat;
\c chat
CREATE EXTENSION IF NOT EXISTS vector;
\c chat_test
CREATE EXTENSION IF NOT EXISTS vector;
