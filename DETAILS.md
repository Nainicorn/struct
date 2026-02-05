### Tech Stack & Services
- vite, vanilla javascript, handlebars, css
- API gateway, Lambda, IAM, DynamoDB, S3, Bedrock (Claude Sonnet), Cloudwatch (logging & monitoring)

### TO-DO Naina
- extract punk app logic for renders list, new render, edit render, show render
- extract mason dash logic for dynamo, lambda, api gateway structure for basic login and credentials functionality
- combine logic into one .md file

-----------------------------------------------------------------------

### Leidos Task Delegation

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

**TASK 9 - set up remaining AWS infrastructure**
ASSIGNED TO:

*APPLICABLE FOR SUB-TASKS*

DETAILS:
- 
--------------------------------------------------------------------------

**TASK 10 - set up working AI pipeline with Bedrock and S3 raw data**
ASSIGNED TO: Naina

DETAILS:
- 
--------------------------------------------------------------------------

**TASK 11 - IFC file generation with Lambda**
ASSIGNED TO: Naina

DETAILS:
- 
--------------------------------------------------------------------------

**TASK 11 - Store file in S3 and grab to use in frontend**
ASSIGNED TO: Naina

DETAILS:
- 
--------------------------------------------------------------------------

**TASK 12 - work on app page functionality cont...**

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


**TASK 13 - final testing and validation (full workflow -- sample user story)**

ASSIGNED TO: everyone

DETAILS:
- 
--------------------------------------------------------------------------

ASK at meeting:
- we are currently working on the frontend as mentioned in the email: the frontend won't be anything too formal but it will have the necessary requirements and design that is needed for a working version of the app with all the important details. for example, the interface will be similar to chatgpt or claude where there will be a chatbox window to upload pdfs/images and/or write plaintext and a sidebar with a list of each respective user/engineers "renders". When a user opens a single render, all associated files, the full history log of the llms thinking process, and a generated description and title will be provided. obviously there are reach goals but for the mvp this is our goal and one question i have is what services do you absolutely want us to use during this process as I previously worked on a app where I simulated login via cookies and connected the frontend and backend through api gateway and stored user credentials and information about renders on dynamodb and use lambda for any logic. Then we were going to use of course Bedrock with the Claude model for analysis of the raw data that you will be providing us that will be in S3 and use lambda again for IFC generation logic with openshell. Other than these main services and probably a couple others i might be missing do you have any that you need us to use or any other functionality you prefer so we know beforehand. I know we went over a potential implementation plan in our proposal but sometimes after you start working or thinking about the architecture things can change so we wanted to ask about that. I was planning to do mock login and functionality without cognito or a different database but if you prefer cognito let us know. I think if we are able to get the mvp done around April then we may have time to work on any possible reach goals

- we will be sending the weekly report out tomorrow
- our first updates on the GitHub repo should be sent in by tonight or tomorrow


### Reach Goals
  - Agentic capabilities
  - Automatically detect and ingest new input files
  - Feed new edits back to Claude for refinement (human in the loop)
  - Incrementally update existing IFC files
  - Cognito authentication
  - Amplify hosting with DNS setup