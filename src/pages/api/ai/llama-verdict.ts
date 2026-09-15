import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const user = (locals as any).user;
    if (!user || user.userType !== 'employer') {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    const body = await request.json();
    const { candidateName, candidateSkills, experienceYears, location, bio, coverLetter,
            jobTitle, jobRequirements, jobDescription, experienceLevel, matchingSkills,
            missingSkills, overallScore } = body;

    if (!jobTitle || !candidateName) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 });
    }

    const systemPrompt = 'You are an expert AI recruiter for JobNed, a professional job portal. Give a sharp, honest, actionable hiring verdict. Be direct and specific. Use bullet points. Maximum 200 words total.';

    const skillsStr = Array.isArray(candidateSkills) ? candidateSkills.join(', ') : (candidateSkills || 'None listed');
    const matchingStr = Array.isArray(matchingSkills) ? matchingSkills.join(', ') : 'None';
    const missingStr = Array.isArray(missingSkills) ? missingSkills.join(', ') : 'None';

    const userPrompt = [
      `Candidate: ${candidateName}`,
      `Experience: ${experienceYears ?? 'Not specified'} years`,
      `Location: ${location || 'Not specified'}`,
      `Skills: ${skillsStr}`,
      `Bio: ${bio || 'No bio provided'}`,
      `Cover Letter: ${coverLetter ? String(coverLetter).substring(0, 300) : 'Not provided'}`,
      '',
      `Job Title: ${jobTitle}`,
      `Experience Level Required: ${experienceLevel || 'Not specified'}`,
      `Job Requirements: ${jobRequirements ? String(jobRequirements).substring(0, 400) : 'Not specified'}`,
      '',
      `AI Match Score: ${overallScore}%`,
      `Matching Skills: ${matchingStr}`,
      `Missing Skills: ${missingStr}`,
      '',
      'Provide:',
      '1. **Hiring Verdict** (Strongly Recommend / Recommend / Consider / Pass)',
      '2. **Key Strengths** (2-3 bullet points)',
      '3. **Concerns / Gaps** (1-2 bullet points)',
      '4. **Suggested Interview Focus** (1 bullet point)',
      '5. **One-line Summary** for the hiring manager',
    ].join('\n');

    const ai = (env as any).AI;
    if (!ai) {
      return new Response(JSON.stringify({ error: 'AI binding not configured' }), { status: 500 });
    }

    const response = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 512,
      temperature: 0.4,
    });

    const verdict = response?.response || response?.result?.response || 'Unable to generate verdict.';

    return new Response(JSON.stringify({ verdict, model: 'llama-3.3-70b-instruct-fp8-fast' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err: any) {
    console.error('[llama-verdict] Error:', err);
    return new Response(JSON.stringify({ error: err.message || 'AI verdict generation failed' }), { status: 500 });
  }
};
