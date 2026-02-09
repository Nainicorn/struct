### Leidos Task Delegation

## TO-DO

**TASK 1: GitHub setup**

ASSIGNED TO: everyone

DETAILS:
- configure access to GitHub Repository
- clone repository
- test push to make sure everyones access works

--------------------------------------------------------------------------

**TASK 2: Create vite app and setup basic repo environment for UI**

ASSIGNED TO:

DETAILS:
- command line: write npx create vite@latest . (dot is for current folder)
- write package name as "builting"
- choose vanilla, choose javascript
- choose no rolldown-vite
- click install, (make sure node.js/npm is installed on your computer)
- install some extensions for VSCode if needed

--------------------------------------------------------------------------

**TASK 3 - cleanup vite app and connect to claude code**

ASSIGNED TO:

DETAILS:
- do not touch node modules
- install claude code extension and connect to claude via terminal or console
- remove public folder and contents:
- open src, delete counter.js
- delete javascript.svg
- remove all code in main.js but keep the file
- remove all code in styles.css but keep the file
- do not touch gitignore
- do not touch index.html

--------------------------------------------------------------------------

**TASK 4: create frontend folder structure and install dependencies/extensions**

ASSIGNED TO:

DETAILS:
- create CLAUDE.md file that holds all necessary information about project, tech stack, structure, and requirements
- using claude code create a boilerplate structure for the frontend, no code just shells for files & folders
- install any necessary dependencies now and throughout the project if need be (i.e. handlebars, ifc, etc.)
- install any necessary extensions on VSCode

--------------------------------------------------------------------------

**TASK 5: work on login page design**

ASSIGNED TO:

DETAILS:
* all the files are in place, now we code
* NOTE: everytime we code, make sure we are using best practices for prompting and claude code will always refer to our project structure .md file
- create background
- create login box and finish design

--------------------------------------------------------------------------

**TASK 5: work on login page functionality and set up basic AWS infrastructure**

ASSIGNED TO:

*APPLICABLE FOR SUB-TASKS*

DETAILS:
- set up login functionality using cookies
- set up API gateway
- connect frontend to server (backend)
- create dynamoDB table to store users
- create lambda function for any necessary logic
- test user login and creation functionality

--------------------------------------------------------------------------

**TASK 7 -  work on app page design**

ASSIGNED TO:

*APPLICABLE FOR SUB-TASKS*

DETAILS:
- create header design and fields (logo, collapse sidebar, username displayed, logout button)
- create chatbox design and fields (input field)
- create sidebar design and fields (new render, renders boxes list, edit render button on each render)

--------------------------------------------------------------------------

**TASK 8 - work on app page functionality**

ASSIGNED TO:

*APPLICABLE FOR SUB-TASKS*

DETAILS:
- collapse sidebar function logic
- logout button function logic
- username properly displayed function logic

*BREAK*

--------------------------------------------------------------------------

**************************************************************************
AT THIS STAGE FRONTEND IS 80% DONE (backend implementation now)
**************************************************************************


**TASK 9 - set up remaining AWS infrastructure**
ASSIGNED TO: Naina (for now, will be the rest of the team after I'm done)

*APPLICABLE FOR SUB-TASKS*

DETAILS:
- 
--------------------------------------------------------------------------

**TASK 10 - Bedrock pipeline**
ASSIGNED TO: Naina

DETAILS:
- 
--------------------------------------------------------------------------

**TASK 11 - IFC file generation**
ASSIGNED TO: Naina

DETAILS:
- 
--------------------------------------------------------------------------

**TASK 12 - Frontend/Backend Integration**
ASSIGNED TO: Naina

DETAILS:
- 
--------------------------------------------------------------------------

**TASK 13 - work on app page functionality cont...**

ASSIGNED TO:

*APPLICABLE FOR SUB-TASKS*

DETAILS:
- start chat function via input field
- new render function when user logs in
- renders boxes list shown dynamically for each user (not static content, must actually grab from S3)
- edit render button function
- show render function: when edit is clicked, respective render is shown
  - show associated files grabbed from S3 raw data
  - show AI generated description and title for render
  - show full generation logic step-by-step to find any errors or analyze (for future human in the loop)
  - display render using ifc function logic

--------------------------------------------------------------------------


**TASK 14 - final testing and validation (full workflow -- sample user story)**

ASSIGNED TO: everyone

DETAILS:
- 
--------------------------------------------------------------------------

### Reach Goals
  - Agentic capabilities
  - Automatically detect and ingest new input files
  - Feed new edits back to Claude for refinement (human in the loop)
  - Incrementally update existing IFC files
  - Cognito authentication
  - Amplify hosting with DNS setup