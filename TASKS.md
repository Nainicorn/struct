the most helpful thing right now is looking at the tunnel_structure_only_example01 file it rendered a perfect 3d model, but my pipeline was only able to generate whats in output.ifc which isnt much and its based on some half-assed data, so is there any way you can give me a detailed pdf file or txt file that has enough details to replicate the detail that tunnel_structure_only_example01 has? because eventually my lambda functions will have to take in multiple files and create a nice render so could you create files that i can submit into frontend that will generate a proper ifc file?

{
  "userId": "user-1",
  "renderId": "ace6e6a1-9f3c-4f99-be19-13128e12ffeb",
  "bucket": "builting-data"
}


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

**TASK 15 - reach goals with continued testing**

ASSIGNED TO: everyone

DETAILS:
- Agentic capabilities
  - Automatically detect and ingest new input files
  - Feed new edits back to Claude for refinement (human in the loop)
  - Incrementally update existing IFC files
  - Cognito authentication
  - Amplify hosting with DNS setup
--------------------------------------------------------------------------
  