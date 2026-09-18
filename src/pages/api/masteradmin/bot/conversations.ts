import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/db';
import { botConversations, botMessages } from '../../../../db/schema';
import { eq, asc, desc } from 'drizzle-orm';

export const GET: APIRoute = async ({ request, locals }) => {
  // @ts-ignore
  const user = locals.user;
  if (!user || (user.userType !== 'masteradmin' && user.userType !== 'superadmin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized: MasterAdmin access required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const url = new URL(request.url);
    const convId = url.searchParams.get('id');

    if (!convId) {
      return new Response(JSON.stringify({ error: 'Conversation ID is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const db = getDb();
    const conversation = await db
      .select()
      .from(botConversations)
      .where(eq(botConversations.id, convId))
      .get();

    if (!conversation) {
      return new Response(JSON.stringify({ error: 'Conversation not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const messages = await db
      .select()
      .from(botMessages)
      .where(eq(botMessages.conversationId, convId))
      .orderBy(asc(botMessages.createdAt))
      .all();

    return new Response(JSON.stringify({
      success: true,
      conversation,
      messages,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[bot-conversations-api] Error fetching conversation:', err);
    return new Response(JSON.stringify({ error: err.message || 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  // @ts-ignore
  const user = locals.user;
  if (!user || (user.userType !== 'masteradmin' && user.userType !== 'superadmin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized: MasterAdmin access required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    const { id } = body;

    if (!id) {
      return new Response(JSON.stringify({ error: 'Conversation ID is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const db = getDb();
    await db
      .update(botConversations)
      .set({ isDeleted: true })
      .where(eq(botConversations.id, id))
      .run();

    return new Response(JSON.stringify({
      success: true,
      message: 'Conversation deleted successfully',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[bot-conversations-api] Error deleting conversation:', err);
    return new Response(JSON.stringify({ error: err.message || 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
