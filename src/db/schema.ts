import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// --- USERS ---
export const users = sqliteTable('users', {
  id: text('id').primaryKey(), // UUID
  userType: text('user_type').notNull(), // 'employee' | 'employer' | 'admin' | 'superadmin' | 'masteradmin'
  email: text('email').notNull().unique(),
  phone: text('phone'),
  passwordHash: text('password_hash').notNull(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  verifiedStatus: text('verified_status').default('pending').notNull(), // 'pending' | 'verified' | 'rejected'
  verifiedAt: integer('verified_at', { mode: 'timestamp' }),
  verifiedBy: text('verified_by'), // UUID of Admin
  planId: text('plan_id'), // P001, P002, P003 (removed foreign key reference to bypass D1 local emulator bug)
  planExpiresAt: integer('plan_expires_at', { mode: 'timestamp' }),
  subscriptionStatus: text('subscription_status').default('inactive'), // 'active' | 'inactive' | 'cancelled'
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  companyName: text('company_name'),
  companyWebsite: text('company_website'),
  companyIndustry: text('company_industry'),
  companySize: text('company_size'),
  companyBio: text('company_bio'),
  avatarUrl: text('avatar_url'),
  // --- EMPLOYEE PROFILE FIELDS ---
  headline: text('headline'),                              // e.g. "Full Stack Developer | React"
  bio: text('bio'),                                       // personal bio
  skills: text('skills', { mode: 'json' }),              // JSON array e.g. ["React","Python"]
  location: text('location'),                             // city/country
  linkedinUrl: text('linkedin_url'),
  portfolioUrl: text('portfolio_url'),
  experienceYears: integer('experience_years'),
  workExperience: text('work_experience', { mode: 'json' }), // JSON array [{ jobTitle, company, skillsUsed, startDate, endDate, currentlyWorking, description }]
  education: text('education', { mode: 'json' }),        // JSON array [{ degree, institution, year }]
  defaultResumeUrl: text('default_resume_url'),          // default resume link for quick-apply
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
  isDeleted: integer('is_deleted', { mode: 'boolean' }).default(false),
});

// --- PLANS ---
export const plans = sqliteTable('plans', {
  planId: text('plan_id').primaryKey(), // P001, P002, P003 (NEVER CHANGES)
  planName: text('plan_name').notNull(),
  description: text('description'),
  jobPostingLimit: integer('job_posting_limit').notNull(),
  resumeLimit: integer('resume_limit').notNull(),
  candidateApplyLimit: integer('candidate_apply_limit').notNull().default(200),
  price: real('price').notNull(),
  annualPrice: real('annual_price').notNull().default(0),
  currency: text('currency').default('USD').notNull(),
  billingCycle: text('billing_cycle').default('monthly'), // 'monthly' | 'annual'
  features: text('features', { mode: 'json' }), // JSON array of features
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
});

// --- JOB POSTINGS ---
export const jobPostings = sqliteTable('job_postings', {
  id: text('id').primaryKey(), // UUID
  employerId: text('employer_id').references(() => users.id).notNull(),
  jobTitle: text('job_title').notNull(),
  description: text('description').notNull(), // max 5000 chars enforced in application logic
  requirements: text('requirements', { mode: 'json' }), // JSON array of strings
  salaryMin: real('salary_min'),
  salaryMax: real('salary_max'),
  salaryCurrency: text('salary_currency').default('USD'),
  locationCity: text('location_city'),
  locationRemote: integer('location_remote', { mode: 'boolean' }).default(false),
  employmentType: text('employment_type'), // 'Full-time' | 'Part-time' | 'Contract' | 'Internship'
  experienceLevel: text('experience_level'), // 'Entry' | 'Mid' | 'Senior' | 'Lead'
  status: text('status').default('draft'), // 'draft' | 'published' | 'closed'
  applicationsCount: integer('applications_count').default(0),
  maxResumesAllowed: integer('max_resumes_allowed'),
  viewCount: integer('view_count').default(0),
  applicationFormConfig: text('application_form_config', { mode: 'json' }), // JSON Object for custom required fields and questions
  externalApplyUrl: text('external_apply_url'), // Link to company career page / ATS if external
  applyMode: text('apply_mode').default('internal'), // 'internal' | 'redirect' | 'native_forward'
  sourceType: text('source_type').default('internal'), // 'internal' | 'crawled'
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
  publishedAt: integer('published_at', { mode: 'timestamp' }),
  closedAt: integer('closed_at', { mode: 'timestamp' }),
  isDeleted: integer('is_deleted', { mode: 'boolean' }).default(false),
});

// --- APPLICATIONS ---
export const applications = sqliteTable('applications', {
  id: text('id').primaryKey(), // UUID
  jobPostingId: text('job_posting_id').references(() => jobPostings.id).notNull(),
  applicantId: text('applicant_id').references(() => users.id).notNull(),
  employerId: text('employer_id').references(() => users.id).notNull(),
  resumeUrl: text('resume_url').notNull(),
  coverLetter: text('cover_letter'),
  customAnswers: text('custom_answers', { mode: 'json' }), // JSON array of { questionId, text, answer }
  status: text('status').default('received'), // 'received' | 'under_review' | 'shortlisted' | 'rejected' | 'accepted'
  statusHistory: text('status_history', { mode: 'json' }), // JSON array of { status, updated_at }
  rating: integer('rating'), // 1-5
  aiScore: integer('ai_score'), // 0-100 match score from Gemini API
  aiSummary: text('ai_summary'), // Brief explanation from Gemini API
  notes: text('notes'),
  remarks: text('remarks'),
  appliedAt: integer('applied_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
  isDeleted: integer('is_deleted', { mode: 'boolean' }).default(false),
});

// --- RECOMMENDATIONS ---
export const recommendations = sqliteTable('recommendations', {
  id: text('id').primaryKey(), // UUID
  employeeId: text('employee_id').references(() => users.id).notNull(),
  jobPostingId: text('job_posting_id').references(() => jobPostings.id).notNull(),
  matchScore: real('match_score').notNull(), // 0-100
  skillMatch: real('skill_match').notNull(),
  experienceMatch: real('experience_match').notNull(),
  preferenceMatch: real('preference_match').notNull(),
  locationMatch: real('location_match').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
});

// --- POSTS (FEED) ---
export const posts = sqliteTable('posts', {
  id: text('id').primaryKey(), // UUID
  authorId: text('author_id').notNull(),
  content: text('content').notNull(),
  mediaUrl: text('media_url'),
  mediaType: text('media_type'), // 'image' | 'video' | 'link'
  status: text('status').default('published'), // 'draft' | 'published' | 'deleted'
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
  isDeleted: integer('is_deleted', { mode: 'boolean' }).default(false),
});

// --- NOTIFICATIONS ---
export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(), // UUID
  userId: text('user_id').references(() => users.id).notNull(), // Recipient ID (admin/superadmin)
  title: text('title').notNull(),
  message: text('message').notNull(),
  type: text('type').default('system'), // 'system', 'registration', 'alert'
  isRead: integer('is_read', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
});

// --- JOB SEARCHES (RECOMMENDATION ENGINE) ---
export const jobSearches = sqliteTable('job_searches', {
  id: text('id').primaryKey(), // UUID
  employeeId: text('employee_id').references(() => users.id).notNull(),
  searchQuery: text('search_query').notNull(),
  searchedAt: integer('searched_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
});

// --- USER BEHAVIOR LOGS ---
export const userBehavior = sqliteTable('user_behavior', {
  id: text('id').primaryKey(), // UUID
  userId: text('user_id').references(() => users.id).notNull(),
  actionType: text('action_type').notNull(), // 'view_job', 'apply_job', 'search'
  jobPostingId: text('job_posting_id'), // if applicable
  searchQuery: text('search_query'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
});

// --- MESSAGING ---
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(), // UUID
  participant1Id: text('participant1_id').references(() => users.id).notNull(),
  participant2Id: text('participant2_id').references(() => users.id).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(), // UUID
  conversationId: text('conversation_id').references(() => conversations.id).notNull(),
  senderId: text('sender_id').references(() => users.id).notNull(),
  content: text('content').notNull(),
  isRead: integer('is_read', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
});

// --- INTERVIEWS ---
export const interviews = sqliteTable('interviews', {
  id: text('id').primaryKey(), // UUID
  applicationId: text('application_id').references(() => applications.id).notNull(),
  jobPostingId: text('job_posting_id').references(() => jobPostings.id).notNull(),
  employerId: text('employer_id').references(() => users.id).notNull(),
  candidateId: text('candidate_id').references(() => users.id).notNull(),
  title: text('title').notNull(), // e.g. "Round 1 Technical Interview"
  interviewType: text('interview_type').default('video').notNull(), // 'video' | 'in_person' | 'phone'
  meetingLink: text('meeting_link'), // Google Meet / Zoom URL or Location Address
  scheduledAt: integer('scheduled_at', { mode: 'timestamp' }).notNull(),
  durationMinutes: integer('duration_minutes').default(45).notNull(), // in minutes
  status: text('status').default('scheduled').notNull(), // 'scheduled' | 'rescheduled' | 'completed' | 'cancelled'
  notes: text('notes'), // Interview agenda / instructions
  interviewerNames: text('interviewer_names'), // e.g. "Sarah (Engineering Lead)"
  timezone: text('timezone').default('UTC'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
  isDeleted: integer('is_deleted', { mode: 'boolean' }).default(false),
  candidateDeleted: integer('candidate_deleted', { mode: 'boolean' }).default(false),
});

// --- SAVED JOBS ---
export const savedJobs = sqliteTable('saved_jobs', {
  id: text('id').primaryKey(), // UUID
  userId: text('user_id').references(() => users.id).notNull(),
  jobPostingId: text('job_posting_id').notNull(),
  jobData: text('job_data', { mode: 'json' }), // JSON snapshot of job details
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
});

// --- CRAWLER STAGING QUEUE ---
export const crawledJobsQueue = sqliteTable('crawled_jobs_queue', {
  id: text('id').primaryKey(), // unique hash of company+jobTitle+originalUrl
  sourceUrl: text('source_url').notNull(),
  sourceType: text('source_type').default('career_page').notNull(), // 'greenhouse' | 'lever' | 'career_page' | 'rss'
  companyName: text('company_name').notNull(),
  companyWebsite: text('company_website'),
  companyLogo: text('company_logo'),
  companyTier: text('company_tier').default('startup_small'), // 'big_tech' | 'startup_small'
  jobTitle: text('job_title').notNull(),
  description: text('description').notNull(),
  requirements: text('requirements', { mode: 'json' }), // JSON array of strings
  salaryMin: real('salary_min'),
  salaryMax: real('salary_max'),
  salaryCurrency: text('salary_currency').default('USD'),
  locationCity: text('location_city'),
  locationRemote: integer('location_remote', { mode: 'boolean' }).default(false),
  employmentType: text('employment_type').default('Full-time'),
  experienceLevel: text('experience_level').default('Mid'),
  externalApplyUrl: text('external_apply_url'),
  contactEmail: text('contact_email'),
  applyMode: text('apply_mode').default('redirect'), // 'redirect' | 'native_forward'
  originalPostedAt: integer('original_posted_at', { mode: 'timestamp' }), // used to strictly enforce < 24 hrs rule
  status: text('status').default('pending').notNull(), // 'pending' | 'published' | 'skipped' | 'failed'
  publishedJobId: text('published_job_id'),
  crawledAt: integer('crawled_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
  publishedAt: integer('published_at', { mode: 'timestamp' }),
});

// --- CRAWLER CONFIG & RATE LIMIT SETTINGS ---
export const crawlerSettings = sqliteTable('crawler_settings', {
  key: text('key').primaryKey(), // 'jobs_per_batch' | 'interval_hours' | 'max_age_hours' | 'auto_publish' | 'last_run_at'
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
});

// --- BOT CONVERSATIONS (AI CHATBOT LOGGING) ---
export const botConversations = sqliteTable('bot_conversations', {
  id: text('id').primaryKey(), // UUID session id
  visitorName: text('visitor_name').default('Anonymous').notNull(),
  visitorEmail: text('visitor_email'),
  userId: text('user_id'), // optional references users.id
  status: text('status').default('active').notNull(), // 'active' | 'closed'
  messageCount: integer('message_count').default(0).notNull(),
  lastMessage: text('last_message'),
  currentPath: text('current_path'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
  isDeleted: integer('is_deleted', { mode: 'boolean' }).default(false),
});

// --- BOT MESSAGES ---
export const botMessages = sqliteTable('bot_messages', {
  id: text('id').primaryKey(), // UUID
  conversationId: text('conversation_id').notNull(),
  sender: text('sender').notNull(), // 'user' | 'assistant'
  content: text('content').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(strftime('%s', 'now'))`),
});
