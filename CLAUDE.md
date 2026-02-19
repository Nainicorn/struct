# Text-to-3D Project Status & Architecture

**Claude Code Constraints**
- update claude.md file everytime you or user finishes a part of the major implementation & when you or user updates code/zip
- everytime a task is complete, remove the context associated with it in the claude.md file and put it into completed.md
- claude.md should only contain main context of project and remaining steps and completed.md should contain everything that has been implemented both in frontend and backend
- ask user before you compact
- when compacting, look at previous chat AND updated.md AND claude.md to get full scope so you don't forget important context
- separate each task into sub-tasks if needed and only after completion, move to the next task (go step by step)
- use plan mode everytime you plan out the next phase or tasks
- when you start working on the backend implementation via AWS suggest any improvements IF necessary
- everytime lambda function updated and user needs to upload new zip file, YOU take care of the zip function

## Project Overview

A full-stack application that focuses on extracting large amounts of raw unstructured building information modeling (BIM) content from plaintext, images, blueprints, sensors, pdfs, etc. and generates a 3D model file (IFC) format to view in either built-in frontend interface via a web ifc viewer OR to download and view in 3D modeling tools such as Revit. The goal is to create a digital twin of a building or structure and all of its functional components. The tech stack includes a no-framework approach by simply using vanilla javascript, html/hbs and css while the backend is all configured through AWS.

## Codebase Overview

The backend folder contains the most recent code or information that is is identical to the current setup of AWS at any given time. This will continue to be updated as the project develops further for better context for Claude Code and user. The ui folder contains all of the components (both structure and style) on the screen and connections to backend; it also uses a ecmascript6+ based folder/file structure. The goal is to keep the codebase extremely clean and easy to understand and navigate. The ifc folder is all the test files used during each current render test.

## Core Flow

- User logins
    - DynamoDB has test user listed in the "builting-users" table
    - user is authorized via cookies in frontend and through API gateway "builting-api" and Lambda logic in "builting-main"

- User has access to their home page which contains header, renderbox, sidebar, etc.
    - User can click logout button in the header and be redirected back to the login screen
    - User can click the sidebar collapse button in the header to collapse the sidebar for more renderbox real-estate
    - User can start new render
        - user can start new render by clicking "new render +" button or at login when showed the default renderbox screen
        - user should be able to upload new files and documents from their computer (.txt, .pdf, .img) and if they type in the renderbox input box the text will be converted automatically into .txt and sent in with the other files
        - the files and documents will be sent into S3 bucket "builting-data" (the S3 bucket and user should be connected properly)
        - a loading state element will appear on the screen until the IFC file is generated in the backend, the frontend will receive it and the ifc viewer in the frontend will render it along with other details like an ai-generated title, description, all of the raw data files from "builting-data" S3 bucket, and a function to download the IFC file
    - User can view old renders which are embedded inside sidebar
        - the old render will be a square shaped element that has the title of the render and the 3d static image preview
        - when the user clicks on an old render, they should be able to see details like an ai-generated title, description, all of the raw data files from "builting-data" S3 bucket, and a function to download the IFC file
        - the ifc file will be retrieved from the S3 bucket "builting-ifc"

- UI Acrhitecture
   - components
      - renderbox: main interface where user can upload renders and later view renders and details via ifc viewer
      - details: render details card
      - controls: create new render button functionality
      - header: header of the app split into parts based on functionality and design
      - ifc-viewer
      - layout: overall app layout that holds all components
      - login: login page when user logs in or is logged out
      - sidebar: where users old renders are stored and new renders are displayed after each render upload
   - main.js -> entry point of app and decides if layout or login should be displayed based on if user logged in
   - framework
      - messages.js
   - services
      - auth
      - aws
      - cookies
      - renders
      - uploads
      - users
      - users store

- Backend Architecture
    - dynamoDB builting-renders table holds each users renders
      - user_id (String), render_id (String), ai_generated_description, ai_generated_title, created_at, description, ifc_s3_path, s3_path, source_files, status

    - dynamoDB builting-users table holds each users information
      - id (String), created_at, email, name, password
      - for testing -> id: user-1, email: nkoujala@gmail.com, name: Sreenaina, password: Bujji1125$

    - lambda functions
      - builting-main
      - builting-orchestrator-trigger
      - builting-bedrock-ifc
      - builting-read-metadata
      - builting-store-ifc
      - builting-json-to-ifc

    - Step Function
      - builting-render-state-machine

    - SNS topic
      - builting-render-triggers

    - IAM role
      - builting-lambda-execution-role
         - AmazonBedrockFullAccess, AmazonDynamoDBFullAccess, AmazonS3FullAccess, CloudWatchLogsFullAccess

   - API gateway
      - builting-api
      - structure:
      /
         /api
            /auth
               OPTIONS
               POST
            /renders
               GET
               OPTIONS
               POST
               /{id}
                  DELETE
                  GET
                  OPTIONS
                  /download
                     GET
                     OPTIONS
            /uploads
               /presigned
                  OPTIONS
                  POST
            /users
               OPTIONS
               /{id}
                  GET
                  OPTIONS
   
   - Cloudwatch log groups
      - builting-main
      - builting-bedrock-ifc
      - builting-read-metadata
      - builting-store-ifc
      - builting-json-to-ifc

   - S3 buckets
      - builting-data (raw data user uploads for each user render)
      - builting-ifc (generated ifc file for each user render)

---

## Project Status

TO-DO:
- SNS topic (builting-render-triggers) is configured but not attached
- S3 event notifications need to be configured
- lambda functions and state machine needs to be tweaked as logic is not perfect, generated ifc file doesn't include all necessary elements
- generated ifc file needs to be properly rendered in the frontend ifc viewer -- xeokit not recignizing geometry
- fix any major bugs and get the full flow working and the ifc file should be properly generated and viewable

### Reach Goals
1. Human-in-the-loop approval in Step Function
2. Edit/retry failed renders
3. Monitoring & logging improvements

**challenges**: changed approach from json to ifc instead of raw to ifc