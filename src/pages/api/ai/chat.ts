import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '../../../lib/db';
import { jobPostings, users, botConversations, botMessages } from '../../../db/schema';
import { eq, and, or, like, desc } from 'drizzle-orm';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface StructuredJob {
  id: string;
  jobTitle: string;
  companyName: string;
  locationCity: string | null;
  locationRemote: boolean;
  employmentType: string | null;
  experienceLevel: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
}

function formatCapitalizedName(str: string): string {
  return str
    .trim()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function isGenericRefusalOrQuestion(str: string): boolean {
  const s = str.toLowerCase().trim().replace(/[.!?]+$/, '');
  const blocked = new Set([
    'no', 'nope', 'nah', 'not now', 'skip', 'anonymous', 'none', 'nothing', 'why', 'who', 'what', 'later',
    'dont want', "don't want", 'prefer not', 'secret', 'test', 'hi', 'hello', 'hey', 'help', 'jobs', 'job',
    'python', 'react', 'developer', 'pricing', 'apply', 'employer', 'candidate', 'screening', 'remote',
    'salary', 'salaries', 'login', 'register', 'how', 'can you', 'show me', 'about', 'services', 'find',
    'good morning', 'good evening', 'good afternoon', 'thanks', 'thank you', 'ok', 'okay', 'sure', 'yes',
    'yeah', 'yep', 'fine', 'great', 'awesome', 'cool', 'hiring', 'vacancy', 'openings', 'work', 'internship',
    'fulltime', 'parttime', 'contract', 'freelance', 'engineer', 'frontend', 'backend', 'fullstack', 'designer',
    'sales', 'marketing', 'manager', 'lead', 'senior', 'junior', 'fresher', 'intern', 'resume', 'cv', 'profile'
  ]);
  if (blocked.has(s)) return true;
  if (/(job|role|remote|hiring|price|salary|salaries|apply|application|how|what|why|who|where|when|can|could|would|show|find|opening|vacancy|vacancies|search|hire|recruitment|employer|candidate|interview|resume|profile|account|register|login|signup)/i.test(s)) return true;
  return false;
}

function extractNameFromQuery(text: string): string | null {
  const clean = text.trim();
  if (!clean) return null;

  // Patterns like "My name is John Doe", "I am Alice", "I'm Rahul", "Call me Bob", "Myself Prashant"
  const prefixPatterns = [
    /(?:my\s+name\s+is|i\s+am|i'm|it's|this\s+is|call\s+me|you\s+can\s+call\s+me|myself)\s+([A-Za-z][A-Za-z'.\s]{1,35})/i,
    /^(?:name\s*(?::|is)\s*)([A-Za-z][A-Za-z'.\s]{1,35})/i,
  ];

  for (const pattern of prefixPatterns) {
    const match = clean.match(pattern);
    if (match) {
      let candidate = match[1].trim();
      // Cut off trailing clause if user continued typing (e.g. "My name is Prashant, can you help me find jobs?")
      candidate = candidate.split(/[,.!?\n]|(?:\s+(?:and|can|i|looking|who|how|what|please|where)\b)/i)[0].trim();
      if (candidate.length >= 2 && candidate.length <= 35 && !isGenericRefusalOrQuestion(candidate)) {
        return formatCapitalizedName(candidate);
      }
    }
  }

  // 1 to 3 alphabetic words if message is short (e.g. "Prashant", "Prashant Sharma")
  const words = clean.split(/\s+/);
  if (words.length >= 1 && words.length <= 3) {
    const stripped = clean.replace(/[.!?]+$/, '').trim();
    if (/^[a-zA-Z]+(?:\s+[a-zA-Z]+)*$/.test(stripped) && stripped.length >= 2 && stripped.length <= 35) {
      if (!isGenericRefusalOrQuestion(stripped)) {
        return formatCapitalizedName(stripped);
      }
    }
  }

  return null;
}

async function persistChatToDb(
  conversationId: string,
  visitorName: string,
  userQuery: string,
  botReply: string,
  currentPath: string,
  userId?: string | null
) {
  try {
    const db = getDb();
    const existing = await db
      .select()
      .from(botConversations)
      .where(eq(botConversations.id, conversationId))
      .get();

    const now = new Date();

    if (!existing) {
      await db.insert(botConversations).values({
        id: conversationId,
        visitorName: visitorName || 'Anonymous',
        userId: userId || null,
        status: 'active',
        messageCount: 2,
        lastMessage: botReply.slice(0, 200),
        currentPath: currentPath || '/',
        createdAt: now,
        updatedAt: now,
        isDeleted: false,
      }).run();
    } else {
      const updatedName = (existing.visitorName && existing.visitorName !== 'Anonymous')
        ? existing.visitorName
        : (visitorName && visitorName !== 'Anonymous' ? visitorName : existing.visitorName);

      await db.update(botConversations).set({
        visitorName: updatedName,
        messageCount: (existing.messageCount || 0) + 2,
        lastMessage: botReply.slice(0, 200),
        currentPath: currentPath || existing.currentPath,
        updatedAt: now,
      }).where(eq(botConversations.id, conversationId)).run();
    }

    // Insert user message
    await db.insert(botMessages).values({
      id: crypto.randomUUID(),
      conversationId,
      sender: 'user',
      content: userQuery,
      createdAt: now,
    }).run();

    // Insert bot reply
    await db.insert(botMessages).values({
      id: crypto.randomUUID(),
      conversationId,
      sender: 'assistant',
      content: botReply,
      createdAt: now,
    }).run();
  } catch (err) {
    console.error('[ai-chat] Error persisting conversation to D1:', err);
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const messages: ChatMessage[] = body.messages || [];
    const currentPath: string = body.currentPath || '/';
    let conversationId: string = body.conversationId || crypto.randomUUID();

    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: 'Messages array is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const latestMessage = messages[messages.length - 1];
    const userQuery = latestMessage?.content?.trim() || '';

    // Check if user is authenticated
    // @ts-ignore
    const loggedUser = locals?.user;
    let initialName = loggedUser ? `${loggedUser.firstName || ''} ${loggedUser.lastName || ''}`.trim() : '';

    // Check existing conversation in D1
    let existingConv: any = null;
    try {
      const db = getDb();
      existingConv = await db.select().from(botConversations).where(eq(botConversations.id, conversationId)).get();
    } catch (e) {
      console.warn('[ai-chat] Note loading existing conv:', e);
    }

    let currentVisitorName = existingConv?.visitorName || body.visitorName || initialName || 'Anonymous';

    const userMessages = messages.filter(m => m.role === 'user');
    const userMessageCount = userMessages.length;

    // Inspect if previous assistant message asked for the user's name
    const prevAssistantMsg = [...messages.slice(0, -1)].reverse().find(m => m.role === 'assistant');
    const wasAskingForName = prevAssistantMsg && /(know your name|what is your name|may i know your name|tell me your name|what should i call you|may i ask your name)/i.test(prevAssistantMsg.content);

    const hasEverAskedForName = messages.some(m => 
      m.role === 'assistant' && /(know your name|what is your name|may i know your name|tell me your name|what should i call you|may i ask your name)/i.test(m.content)
    );

    let earlyReply: string | null = null;
    let structuredJobs: StructuredJob[] = [];
    let justLearnedName = false;

    // 1. Check if user provided their name in this message (either in response to prompt or unprompted)
    if (currentVisitorName === 'Anonymous') {
      const extractedName = extractNameFromQuery(userQuery);
      if (extractedName) {
        currentVisitorName = extractedName;
        justLearnedName = true;
        const words = userQuery.split(/\s+/);
        const isJustName = words.length <= 4 || /^(?:my\s+name\s+is|i\s+am|i'm|it's|this\s+is|call\s+me|myself)\s+([A-Za-z\s'.]+)[.!?]*$/i.test(userQuery);

        if (isJustName) {
          earlyReply = `Nice to meet you, **${extractedName}**! 👋\n\nHow can I help you today on JobNed?\n• **Search Jobs:** Browse active tech openings & remote positions.\n• **Job Seekers:** Guide on [creating your profile & uploading your resume](/register?role=employee).\n• **Employers:** Instructions on [posting jobs](/employer/jobs/new) & [AI candidate screening](/employer/screening).\n• **Pricing:** Compare [recruitment plans & features](/pricing).\n\nWhat would you like to explore, **${extractedName}**?`;
        }
      } else if (wasAskingForName && /^(no|nope|nah|skip|anonymous|prefer not|not now)$/i.test(userQuery.trim())) {
        earlyReply = `No problem at all! How can I assist you today on JobNed?\n\n• **Search Jobs:** Browse open tech roles & remote positions.\n• **Job Seekers:** Guide on [creating your profile](/register?role=employee).\n• **Employers:** Instructions on [posting jobs](/employer/jobs/new).\n• **Pricing:** Compare [recruitment plans](/pricing).`;
      }
    }

    // 2. If user just said hello / greeting and no earlyReply yet:
    if (!earlyReply && /^(hi|hl|hello|hey|greetings|start)$/i.test(userQuery.trim())) {
      if (currentVisitorName === 'Anonymous') {
        earlyReply = `👋 Hello! Welcome to **JobNed** — your AI-powered job and talent matching platform.\n\nI can help you explore active jobs, guide your resume & applications, or assist employers with hiring and pricing.\n\nWhat would you like to explore today? (And by the way, may I know your name so I can assist you better?)`;
      } else {
        earlyReply = `👋 Hello again, **${currentVisitorName}**! How can I assist you today?\n\n• **Search Jobs:** Browse open tech roles & remote positions.\n• **Job Seekers:** Guide on [creating your profile](/register?role=employee).\n• **Employers:** Instructions on [posting jobs](/employer/jobs/new).\n• **Pricing:** Compare [recruitment plans](/pricing).`;
      }
    }

    // If we have an early tailored greeting / name response, save and return immediately
    if (earlyReply) {
      await persistChatToDb(
        conversationId,
        currentVisitorName,
        userQuery,
        earlyReply,
        currentPath,
        loggedUser?.userId || null
      );

      return new Response(JSON.stringify({
        reply: earlyReply,
        jobs: [],
        conversationId,
        visitorName: currentVisitorName,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. Normal question answering & job searching
    const isJobQuery = /(job|role|position|opening|work|hiring|vacancy|vacancies|present|available|look|find|search|python|react|frontend|backend|fullstack|developer|engineer|designer|manager|sales|marketing|remote|internship|hire|company|salaries|salary)/i.test(userQuery);

    let activeJobsContext = '';

    if (isJobQuery) {
      try {
        const db = getDb();
        const stopWords = new Set([
          'is', 'this', 'a', 'an', 'the', 'job', 'jobs', 'present', 'available', 'there', 'any',
          'in', 'for', 'at', 'to', 'on', 'with', 'do', 'you', 'have', 'i', 'am', 'looking', 'what',
          'which', 'how', 'can', 'find', 'show', 'me', 'our', 'platform', 'website', 'please', 'tell', 'give'
        ]);

        const words = userQuery
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length > 2 && !stopWords.has(w));

        let matchingRows: any[] = [];

        if (words.length > 0) {
          const conditions = words.map(word => 
            or(
              like(jobPostings.jobTitle, `%${word}%`),
              like(jobPostings.locationCity, `%${word}%`),
              like(jobPostings.description, `%${word}%`),
              like(users.companyName, `%${word}%`)
            )
          );

          matchingRows = await db
            .select({
              id: jobPostings.id,
              jobTitle: jobPostings.jobTitle,
              companyName: users.companyName,
              locationCity: jobPostings.locationCity,
              locationRemote: jobPostings.locationRemote,
              employmentType: jobPostings.employmentType,
              experienceLevel: jobPostings.experienceLevel,
              salaryMin: jobPostings.salaryMin,
              salaryMax: jobPostings.salaryMax,
              salaryCurrency: jobPostings.salaryCurrency,
            })
            .from(jobPostings)
            .leftJoin(users, eq(jobPostings.employerId, users.id))
            .where(
              and(
                eq(jobPostings.status, 'published'),
                eq(jobPostings.isDeleted, false),
                or(...conditions)
              )
            )
            .orderBy(desc(jobPostings.createdAt))
            .limit(4)
            .all();
        }

        if (matchingRows.length === 0) {
          const latestJobs = await db
            .select({
              id: jobPostings.id,
              jobTitle: jobPostings.jobTitle,
              companyName: users.companyName,
              locationCity: jobPostings.locationCity,
              locationRemote: jobPostings.locationRemote,
              employmentType: jobPostings.employmentType,
              experienceLevel: jobPostings.experienceLevel,
              salaryMin: jobPostings.salaryMin,
              salaryMax: jobPostings.salaryMax,
              salaryCurrency: jobPostings.salaryCurrency,
            })
            .from(jobPostings)
            .leftJoin(users, eq(jobPostings.employerId, users.id))
            .where(
              and(
                eq(jobPostings.status, 'published'),
                eq(jobPostings.isDeleted, false)
              )
            )
            .orderBy(desc(jobPostings.createdAt))
            .limit(4)
            .all();

          if (words.length > 0) {
            activeJobsContext = `\n[DATABASE QUERY RESULT]: No published jobs exactly matched the search keywords "${words.join(', ')}".\nHowever, here are other active published jobs on JobNed:\n` +
              latestJobs.map(j => `- Title: "${j.jobTitle}", Company: ${j.companyName || 'Verified Employer'}, Location: ${j.locationRemote ? 'Remote' : (j.locationCity || 'Onsite')}, Type: ${j.employmentType || 'Full-time'}, Salary: ${j.salaryMin ? `${j.salaryMin}-${j.salaryMax} ${j.salaryCurrency}` : 'Competitive'}, Job Link: /jobs/${j.id}`).join('\n');
          } else {
            activeJobsContext = `\n[DATABASE QUERY RESULT]: Current active published jobs on JobNed:\n` +
              latestJobs.map(j => `- Title: "${j.jobTitle}", Company: ${j.companyName || 'Verified Employer'}, Location: ${j.locationRemote ? 'Remote' : (j.locationCity || 'Onsite')}, Type: ${j.employmentType || 'Full-time'}, Salary: ${j.salaryMin ? `${j.salaryMin}-${j.salaryMax} ${j.salaryCurrency}` : 'Competitive'}, Job Link: /jobs/${j.id}`).join('\n');
          }

          structuredJobs = latestJobs.map(j => ({
            id: j.id,
            jobTitle: j.jobTitle,
            companyName: j.companyName || 'Verified Company',
            locationCity: j.locationCity,
            locationRemote: Boolean(j.locationRemote),
            employmentType: j.employmentType,
            experienceLevel: j.experienceLevel,
            salaryMin: j.salaryMin,
            salaryMax: j.salaryMax,
            salaryCurrency: j.salaryCurrency || 'USD',
          }));
        } else {
          activeJobsContext = `\n[DATABASE QUERY RESULT]: Found ${matchingRows.length} active matching jobs on JobNed:\n` +
            matchingRows.map(j => `- Title: "${j.jobTitle}", Company: ${j.companyName || 'Verified Employer'}, Location: ${j.locationRemote ? 'Remote' : (j.locationCity || 'Onsite')}, Type: ${j.employmentType || 'Full-time'}, Salary: ${j.salaryMin ? `${j.salaryMin}-${j.salaryMax} ${j.salaryCurrency}` : 'Competitive'}, Job Link: /jobs/${j.id}`).join('\n');
          structuredJobs = matchingRows.map(j => ({
            id: j.id,
            jobTitle: j.jobTitle,
            companyName: j.companyName || 'Verified Company',
            locationCity: j.locationCity,
            locationRemote: Boolean(j.locationRemote),
            employmentType: j.employmentType,
            experienceLevel: j.experienceLevel,
            salaryMin: j.salaryMin,
            salaryMax: j.salaryMax,
            salaryCurrency: j.salaryCurrency || 'USD',
          }));
        }
      } catch (dbErr) {
        console.error('[ai-chat] Error fetching jobs from D1:', dbErr);
        activeJobsContext = '\n[DATABASE NOTICE]: Currently unable to query live jobs directly; suggest user visits /jobs to browse all openings.';
      }
    }

    const userNameContext = currentVisitorName && currentVisitorName !== 'Anonymous'
      ? `CRITICAL PERSONALIZATION INSTRUCTION:
- The user's name is "${currentVisitorName}".
- Always address them warmly by their name (e.g., "Certainly, ${currentVisitorName}!", "Here are the top openings for you, ${currentVisitorName}:", "Great question, ${currentVisitorName}!") throughout your answer.
- Talk directly with ${currentVisitorName} using their name so the conversation feels personal, friendly, and attentive.`
      : `USER STATUS: The user is currently Anonymous.`;

    const systemPrompt = `You are the official JobNed AI Guide, the high-performance AI assistant for JobNed (https://jobned.com) — a modern recruitment and job-seeking platform.
The user is currently on the page: "${currentPath}".
${userNameContext}

CORE ASSISTANT INSTRUCTIONS:
- Be concise, direct, accurate, and professional. Avoid fluffy or generic introductory padding.
- Use bold text for key terms and bullet points for lists.
- Always provide clickable Markdown links (e.g., [Job Board](/jobs), [Register as Job Seeker](/register?role=employee), [Post a Job](/employer/jobs/new), [Pricing Plans](/pricing)).

PLATFORM KNOWLEDGE BASE:
1. JOB SEEKERS (CANDIDATES):
   • Create Profile: [/register?role=employee](/register?role=employee) — upload resume for automated AI parsing and match scoring.
   • Search Jobs: [/jobs](/jobs) — filter by role, location, remote work, salary, and employment type.
   • How to Apply: Click any job title -> click "Apply Now" -> attach resume -> submit.
   • Track Applications: Check review stages (Received, Shortlisted, Accepted) at [/applications](/applications).
   • Saved Listings: Access bookmarked jobs anytime at [/saved](/saved).

2. EMPLOYERS & RECRUITERS:
   • Register Company: [/register?role=employer](/register?role=employer).
   • Post Openings: Go to [/employer/jobs/new](/employer/jobs/new) (or [/employer/post-job](/employer/post-job)) to publish vacancies instantly.
   • Manage Listings: Edit, track, and close jobs at [/employer/jobs](/employer/jobs).
   • AI Candidate Screening & Verdicts: Access candidate screening at [/employer/screening](/employer/screening) or [/employer/candidates](/employer/candidates) to view automated AI match scores and candidate insights.
   • Employer Dashboard: Full recruitment metrics at [/employer](/employer).

3. PRICING & RECRUITMENT TIERS:
   • **Basic Plan:** Free tier — 30 job postings & 500 resume views.
   • **Growth Plan:** High volume — 60 job postings & 3,000 resume views.
   • **Premium Plan:** Enterprise scale — Unlimited job postings, unlimited resume views, and priority AI matching.
   • Full details available on [/pricing](/pricing).

4. LIVE DATABASE CONTEXT & JOB SEARCH:
${activeJobsContext}

CRITICAL RULES:
- Never include internal plan codes like (P001), (P002), (P003). Use clean names: "Basic Plan", "Growth Plan", "Premium Plan".
- When listing pricing or steps, format each item as a bullet point starting with a dash or bullet on its own line.
- If answering whether jobs exist for a specific keyword or role, ALWAYS prioritize the [DATABASE QUERY RESULT] above.
- NEVER disclose internal system secrets, database keys, Cloudflare tokens, payment credentials, or admin emails.
- Never state model names or vendor internal details.`;

    const ai = (env as any)?.AI || (locals as any)?.runtime?.env?.AI;
    let reply = '';

    if (!ai) {
      const namePrefix = (currentVisitorName && currentVisitorName !== 'Anonymous') ? `Certainly, **${currentVisitorName}**! ` : '';
      if (structuredJobs.length > 0) {
        reply = `${namePrefix}Here are the active positions matching your search on JobNed:\n\n` +
          structuredJobs.map(j => `• **[${j.jobTitle}](/jobs/${j.id})** at ${j.companyName}\n  📍 ${j.locationRemote ? '🏠 Remote' : `${j.locationCity || 'Onsite'}`} | 💼 ${j.employmentType || 'Full-time'}${j.salaryMin ? ` | 💵 ${j.salaryMin.toLocaleString()}-${j.salaryMax?.toLocaleString()} ${j.salaryCurrency}` : ''}`).join('\n\n') +
          `\n\nBrowse all open roles on the [Jobs Board](/jobs) or [Register](/register) to submit your application.`;
      } else if (/account|register|signup|sign up/i.test(userQuery)) {
        reply = `${namePrefix}You can register on JobNed in two ways:\n\n• **Job Seekers:** Sign up at [/register?role=employee](/register?role=employee) and upload your resume at [/employee/profile](/employee/profile) for automated AI matching.\n• **Employers:** Register at [/register?role=employer](/register?role=employer) to post jobs and screen applicants.`;
      } else if (/post|hiring|employer|how to post/i.test(userQuery)) {
        reply = `${namePrefix}To post a job as an employer:\n\n1. Log into your account at [/login](/login).\n2. Navigate to [Post a Job](/employer/jobs/new).\n3. Fill in the job title, requirements, salary, and location (or toggle Remote).\n4. Click **Publish Job** to go live immediately across JobNed.`;
      } else if (/price|pricing|plan|cost|subscription/i.test(userQuery)) {
        reply = `${namePrefix}JobNed offers the following recruitment plans and pricing:\n\n• **Basic Plan:** Free tier — 30 job postings & 500 resume views.\n• **Growth Plan:** High volume — 60 job postings & 3,000 resume views.\n• **Premium Plan:** Enterprise scale — Unlimited job postings, unlimited resume views, and priority AI matching.\n\nFor full details and upgrades, visit our [Pricing Plans](/pricing) page.`;
      } else {
        reply = (currentVisitorName && currentVisitorName !== 'Anonymous')
          ? `I am your **JobNed AI Guide**, **${currentVisitorName}**! You can browse active jobs at [/jobs](/jobs), register an account at [/register](/register), or post a new role at [/employer/jobs/new](/employer/jobs/new).\n\nWhat would you like to explore?`
          : `I am your **JobNed AI Guide**. You can browse active jobs at [/jobs](/jobs), register an account at [/register](/register), or post a new role at [/employer/jobs/new](/employer/jobs/new).\n\nWhat would you like to explore?`;
      }
    } else {
      const recentMessages = messages.slice(-6).map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: String(m.content).slice(0, 1000),
      }));

      const response = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [
          { role: 'system', content: systemPrompt },
          ...recentMessages,
        ],
        max_tokens: 500,
        temperature: 0.2,
      });

      reply = response?.response || response?.result?.response || 'I am here to help you navigate JobNed. You can browse active jobs at [/jobs](/jobs) or register at [/register](/register).';
    }

    // If user just introduced their name in this message, acknowledge it warmly if not already mentioned
    if (justLearnedName && currentVisitorName !== 'Anonymous' && !reply.toLowerCase().includes(currentVisitorName.toLowerCase())) {
      reply = `Nice to meet you, **${currentVisitorName}**! 👋\n\n` + reply;
    }

    // If user is Anonymous after 1 or 2 questions and bot hasn't asked yet, politely ask for their name
    if (
      currentVisitorName === 'Anonymous' &&
      !hasEverAskedForName &&
      userMessageCount >= 1 &&
      userMessageCount <= 2 &&
      !/(know your name|what is your name|what should i call you|tell me your name|may i ask your name)/i.test(reply)
    ) {
      reply += `\n\n💬 *By the way, may I know your name so I can assist you better and address you personally?*`;
    }

    // Persist conversation and messages to D1 database
    await persistChatToDb(
      conversationId,
      currentVisitorName,
      userQuery,
      reply,
      currentPath,
      loggedUser?.userId || null
    );

    return new Response(JSON.stringify({
      reply,
      jobs: structuredJobs,
      conversationId,
      visitorName: currentVisitorName,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err: any) {
    console.error('[ai-chat] Error:', err);
    return new Response(JSON.stringify({ 
      error: 'Failed to generate response. Please try again.',
      details: err.message 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
