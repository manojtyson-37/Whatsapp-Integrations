<RULE[vercel_deployment_verification]>
After pushing code to the repository, ALWAYS verify whether the Vercel deployment succeeded by checking the deployment status (e.g., using `vercel ls` or checking the Vercel URL) before reporting back to the user.
</RULE[vercel_deployment_verification]>

<RULE[proactive_ui_verification]>
When adding new frontend features or data types (e.g., new message formats, new API endpoints), ALWAYS proactively verify edge cases before considering the task complete. This includes:
1. Ensuring the UI has a fallback or distinct rendering for different data types (e.g., preventing documents from being rendered inside image tags).
2. Verifying that environment variables (like API URLs) behave correctly in both development and production (Vercel) environments without incorrectly defaulting to `localhost` in production.
3. Anticipating how edge cases will be handled by the UI so the user does not experience broken layouts or failed network requests.
</RULE[proactive_ui_verification]>

<RULE[roadmap_adherence]>
ALWAYS consult `ROADMAP.md` in the root directory before starting any major feature or architectural changes. Make sure to adhere to the phases outlined in it. If a phase is completed or requirements change, proactively update `ROADMAP.md` to reflect the latest state.
</RULE[roadmap_adherence]>

<RULE[live_environment_verification]>
ALWAYS verify the edits you make directly on the live production environment immediately after a deployment finishes. Do not assume your code works simply because it compiled or worked locally. You must check the live application URL or Vercel logs to confirm the changes are working in production before reporting back to the user.
</RULE[live_environment_verification]>
