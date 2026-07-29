require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const csv = require('csv-parser');
const stream = require('stream');
const stripeRoutes = require('./stripe');
const teamRoutes = require('./team');

const app = express();
const PORT = process.env.PORT || 3001;

const { createClient } = require('@supabase/supabase-js');

// Supabase Configuration
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
}

// --- Webhooks that require raw body ---
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

app.post('/api/stripe/webhook', express.raw({type: 'application/json'}), async (request, response) => {
  const sig = request.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(request.body, sig, endpointSecret);
  } catch (err) {
    return response.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const workspace_id = session.client_reference_id;
      const plan_type = session.metadata?.plan_type || 'pro';
      if (workspace_id) {
        await supabase.from('workspaces').update({
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          plan_type: plan_type,
          subscription_status: 'active'
        }).eq('id', workspace_id);
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const status = subscription.status;
      await supabase.from('workspaces').update({
        subscription_status: status,
        current_period_end: new Date(subscription.current_period_end * 1000).toISOString()
      }).eq('stripe_subscription_id', subscription.id);
    }
  } catch (err) {
    console.error('Error handling webhook event:', err);
  }

  response.send();
});

// Middleware
app.use(cors());
app.use(express.json());
const analyticsRoute = require('./analytics');
app.use('/api/team', teamRoutes);
app.get('/api/analytics', analyticsRoute);
app.use('/api/stripe', stripeRoutes);

// --- Configuration ---

// Interakt Configuration
const INTERAKT_BASE_URL = 'https://api.interakt.ai/v1/public';
const getInteraktHeaders = () => {
  if (!process.env.INTERAKT_API_KEY) {
    throw new Error('INTERAKT_API_KEY is not set in environment variables');
  }
  return {
    'Authorization': `Basic ${process.env.INTERAKT_API_KEY}`,
    'Content-Type': 'application/json'
  };
};

// Meta WhatsApp Cloud API Configuration
const getMetaHeaders = () => {
  if (!process.env.META_ACCESS_TOKEN) {
    throw new Error('META_ACCESS_TOKEN is not set in environment variables');
  }
  return {
    'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
    'Content-Type': 'application/json'
  };
};


// --- OUTBOUND API ENDPOINTS ---

/**
 * Sync User with Interakt (Only relevant for Interakt users)
 */
app.post('/api/interakt/track/users', async (req, res) => {
  try {
    const { userId, phoneNumber, countryCode, traits } = req.body;
    if (!phoneNumber || !countryCode) return res.status(400).json({ error: 'phoneNumber and countryCode are required' });

    const payload = {
      userId: userId || undefined,
      phoneNumber: phoneNumber,
      countryCode: countryCode,
      traits: traits || {}
    };

    const response = await axios.post(`${INTERAKT_BASE_URL}/track/users/`, payload, { headers: getInteraktHeaders() });
    res.status(200).json({ success: true, data: response.data });
  } catch (error) {
    console.error('Error tracking user in Interakt:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ success: false, error: error.response?.data || 'Internal Server Error' });
  }
});

/**
 * Unified Message Sending Wrapper
 * Accepts `provider`: "interakt" or "meta"
 */
app.post('/api/whatsapp/message', async (req, res) => {
  try {
    const { provider, countryCode, phoneNumber, templateName, languageCode, bodyValues, buttonValues, messageType, text, interactive, location } = req.body;

    if (!countryCode || !phoneNumber) {
      return res.status(400).json({ error: 'countryCode and phoneNumber are required' });
    }
    
    const type = messageType || 'template';
    if (type === 'template' && !templateName) {
      return res.status(400).json({ error: 'templateName is required when type is template' });
    }

    // Phase 7: Subscription Limit Check (Skipped if no workspace ID is provided in request for now, or assume it's passed)
    if (req.body.workspace_id && supabase) {
      const { data: workspace } = await supabase.from('workspaces').select('subscription_status').eq('id', req.body.workspace_id).single();
      // If billing is strictly enforced, you can block inactive workspaces
      // if (workspace && workspace.subscription_status !== 'active') {
      //   return res.status(403).json({ error: 'Subscription inactive or past due. Please upgrade your plan.' });
      // }
    }

    const targetProvider = provider || 'interakt'; // Default to interakt for backwards compatibility

    if (targetProvider === 'interakt') {
      // -------------------------------------
      // Interakt Payload Construction
      // -------------------------------------
      const payload = {
        countryCode: countryCode,
        phoneNumber: phoneNumber,
        type: 'Template',
        template: {
          name: templateName,
          languageCode: languageCode || 'en',
          headerValues: [], 
          bodyValues: bodyValues || [],
          buttonValues: buttonValues || {}
        }
      };

      const response = await axios.post(`${INTERAKT_BASE_URL}/message/`, payload, { headers: getInteraktHeaders() });
      return res.status(200).json({ success: true, data: response.data, provider: 'interakt' });

    } else if (targetProvider === 'meta') {
      // -------------------------------------
      // Meta Cloud API Payload Construction
      // -------------------------------------
      const isSandbox = req.body.isSandbox === true;
      const { workspace_id } = req.body;
      
      let accessToken = null;
      let phoneNumberId = null;

      if (isSandbox) {
        accessToken = process.env.TEST_META_ACCESS_TOKEN;
        phoneNumberId = process.env.TEST_META_PHONE_NUMBER_ID;
      } else {
        if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required for production Meta API' });
        const { data: ws } = await supabase.from('workspaces').select('*').eq('id', workspace_id).single();
        if (ws) {
           accessToken = ws.meta_access_token;
           phoneNumberId = ws.meta_phone_number_id;
        }
      }

      if (!phoneNumberId || !accessToken) {
        if (isSandbox) {
          console.log(`[SANDBOX MOCK] Missing Meta keys, but sandbox mode is ON. Simulating successful send to ${countryCode}${phoneNumber}...`);
          return res.status(200).json({ 
            success: true, 
            data: {
              messaging_product: "whatsapp",
              contacts: [{ input: `${countryCode.replace('+', '')}${phoneNumber}`, wa_id: `${countryCode.replace('+', '')}${phoneNumber}` }],
              messages: [{ id: `wamid.MOCK_${Date.now()}` }]
            },
            provider: 'meta',
            mocked: true
          });
        } else {
          throw new Error('Meta credentials missing. Please configure META_ACCESS_TOKEN and META_PHONE_NUMBER_ID.');
        }
      }

      const metaHeaders = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      };

      const fullPhoneNumber = `${countryCode.replace('+', '')}${phoneNumber}`;

      let payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: fullPhoneNumber,
        type: type,
      };

      if (type === 'template') {
        // Convert bodyValues ["John", "Order #123"] to Meta format [{type: "text", text: "John"}, ...]
        const parameters = (bodyValues || []).map(val => ({
          type: 'text',
          text: val
        }));
        payload.template = {
          name: templateName,
          language: { code: languageCode || 'en' },
          components: parameters.length > 0 ? [
            {
              type: "body",
              parameters: parameters
            }
          ] : []
        };
      } else if (type === 'text') {
        payload.text = { body: text };
      } else if (type === 'interactive') {
        payload.interactive = interactive;
      } else if (type === 'location') {
        payload.location = location;
      }

      const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;
      const response = await axios.post(url, payload, { headers: metaHeaders });
      
      // Save outbound message to Supabase
      if (supabase && response.data.messages && response.data.messages.length > 0) {
        const messageId = response.data.messages[0].id;
        const insertData = {
          phone_number: fullPhoneNumber,
          message_id: messageId,
          direction: 'outbound',
          type: type,
          content: type === 'template' ? `Template: ${templateName}` : (type === 'text' ? text : (type === 'interactive' ? '[Interactive Message]' : '[Location]')),
          status: 'sent'
        };
        if (workspace_id) insertData.workspace_id = workspace_id;
        
        await supabase.from('messages').insert([insertData]);
      }

      return res.status(200).json({ success: true, data: response.data, provider: 'meta' });
      
    } else {
      return res.status(400).json({ error: { message: 'Invalid provider specified. Use "interakt" or "meta".' } });
    }

  } catch (error) {
    console.error('Error sending message:', error.response?.data || error.message);
    
    let errorObj = error.response?.data?.error || { message: error.message || 'Internal Server Error' };
    
    // Intercept specific Meta sandbox error
    if (errorObj.code === 131030) {
      errorObj.message = "Because you are using Meta Test Keys, you can only send messages to numbers verified in your Meta Dashboard 'Manage phone number list'. Please verify the recipient number there first, or switch to production keys.";
    }

    res.status(error.response?.status || 500).json({
      success: false,
      error: errorObj
    });
  }
});


// --- INBOUND WEBHOOKS ---

/**
 * Meta Webhook Verification (GET)
 * Meta requires you to return the hub.challenge value if the hub.verify_token matches.
 */
app.get('/api/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

/**
 * Unified Webhook Receiver (POST)
 * Receives delivery statuses and inbound messages from both Interakt and Meta.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

app.post('/api/webhooks/whatsapp', async (req, res) => {
  try {
    const payload = req.body;

    // Detect Meta Payload Format (Usually wrapped in `object: "whatsapp_business_account"`)
    if (payload.object) {
      if (payload.entry && payload.entry[0].changes && payload.entry[0].changes[0].value) {
        const value = payload.entry[0].changes[0].value;
        
        // Fetch workspace_id based on Meta Phone Number ID
        let workspace_id = null;
        if (supabase && value.metadata && value.metadata.phone_number_id) {
          const { data: wsData } = await supabase
            .from('workspaces')
            .select('id')
            .eq('meta_phone_number_id', value.metadata.phone_number_id)
            .single();
          if (wsData) workspace_id = wsData.id;
        }

        // Meta Status Update
        if (value.statuses) {
          const status = value.statuses[0];
          console.log(`[META STATUS] Message ${status.id} to ${status.recipient_id} is now ${status.status}`);
          if (supabase) {
            await supabase.from('messages')
              .update({ status: status.status })
              .eq('message_id', status.id);
          }
        }
        
        // Meta Inbound Message
        if (value.messages) {
          const message = value.messages[0];
          const contacts = value.contacts;
          let profileName = null;
          if (contacts && contacts.length > 0 && contacts[0].profile) {
            profileName = contacts[0].profile.name;
          }

          console.log(`[META INBOUND] Received message from ${message.from}`);
          if (supabase) {
            let content = '';
            if (message.type === 'text') content = message.text.body;
            else if (message.type === 'button') content = message.button.text;
            else content = `[${message.type}]`;

            let mediaId = null;
            let mediaMime = null;
            if (message.type === 'image' && message.image) {
              mediaId = message.image.id;
              mediaMime = message.image.mime_type;
              content = message.image.caption || '';
            } else if (message.type === 'sticker' && message.sticker) {
              mediaId = message.sticker.id;
              mediaMime = message.sticker.mime_type;
            } else if (message.type === 'video' && message.video) {
              mediaId = message.video.id;
              mediaMime = message.video.mime_type;
              content = message.video.caption || '';
            } else if (message.type === 'document' && message.document) {
              mediaId = message.document.id;
              mediaMime = message.document.mime_type;
              const docName = message.document.filename || 'Document';
              const docCaption = message.document.caption || '';
              content = `[FILENAME]${docName}[/FILENAME]${docCaption}`;
            } else if (message.type === 'audio' && message.audio) {
              mediaId = message.audio.id;
              mediaMime = message.audio.mime_type;
            } else if (message.type === 'interactive' && message.interactive) {
              if (message.interactive.type === 'button_reply') {
                content = `[BUTTON] ${message.interactive.button_reply.title}`;
              } else if (message.interactive.type === 'list_reply') {
                content = `[LIST] ${message.interactive.list_reply.title}`;
              }
            } else if (message.type === 'location' && message.location) {
              content = `[LOCATION] ${message.location.latitude},${message.location.longitude} - ${message.location.name || ''}`;
            }

            // Attempt to download and store media in Supabase Storage
            let storageUrl = null;
            if (mediaId && workspace_id && supabase) {
              try {
                // We need the workspace's Meta access token
                const { data: ws } = await supabase.from('workspaces').select('meta_access_token').eq('id', workspace_id).single();
                if (ws && ws.meta_access_token) {
                  // Get media URL from Meta
                  const urlResponse = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
                    headers: { 'Authorization': `Bearer ${ws.meta_access_token}` }
                  });
                  
                  // Download media as buffer
                  const mediaResponse = await axios.get(urlResponse.data.url, {
                    headers: { 'Authorization': `Bearer ${ws.meta_access_token}` },
                    responseType: 'arraybuffer'
                  });
                  
                  const ext = mediaMime ? mediaMime.split('/')[1].split(';')[0] : 'bin';
                  const fileName = `${workspace_id}/${message.id}_${mediaId}.${ext}`;
                  
                  // Upload to Supabase
                  const { error: uploadError } = await supabase.storage.from('whatsapp_media').upload(fileName, mediaResponse.data, {
                    contentType: mediaMime,
                    upsert: true
                  });
                  
                  if (!uploadError) {
                    const { data: publicUrlData } = supabase.storage.from('whatsapp_media').getPublicUrl(fileName);
                    storageUrl = publicUrlData.publicUrl;
                  }
                }
              } catch (err) {
                console.error("Failed to store media in Supabase, falling back to dynamic fetch.", err.message);
              }
            }

            const insertData = {
              phone_number: message.from,
              message_id: message.id,
              direction: 'inbound',
              type: message.type,
              content: content,
              status: 'received'
            };
            
            if (workspace_id) insertData.workspace_id = workspace_id;

            if (profileName) insertData.profile_name = profileName;
            
            // If we successfully saved to storage, we'll store the URL in media_id.
            // Otherwise fallback to raw mediaId for dynamic fetch.
            if (storageUrl) {
              insertData.media_id = storageUrl;
            } else if (mediaId) {
              insertData.media_id = mediaId;
            }

            const { error } = await supabase.from('messages').insert([insertData]);
            
            // If insertion fails due to missing columns, retry without them
            if (error && (profileName || mediaId)) {
              console.warn("Insert failed, retrying without extra columns:", error.message);
              delete insertData.profile_name;
              delete insertData.media_id;
              await supabase.from('messages').insert([insertData]);
            }

            // ==========================================
            // AUTO-SAVE CONTACT
            // ==========================================
            if (workspace_id) {
              const contactPayload = { phone_number: message.from, workspace_id };
              if (profileName) contactPayload.name = profileName;
              await supabase.from('contacts').upsert(
                contactPayload,
                { onConflict: 'phone_number', ignoreDuplicates: true }
              );
            }

            // ==========================================
            // AUTOMATION (AUTO-REPLY) LOGIC
            // ==========================================
            if (workspace_id && message.type === 'text') {
              try {
                // Fetch active automations for the workspace
                const { data: automations } = await supabase
                  .from('automations')
                  .select('*')
                  .eq('workspace_id', workspace_id)
                  .eq('is_active', true);
                
                if (automations && automations.length > 0) {
                  let matchedRule = null;

                  // 1. Check Out of Office (OOO) first
                  const oooRule = automations.find(a => a.trigger_type === 'out_of_office');
                  if (oooRule) {
                    matchedRule = oooRule; // For MVP, if active, it fires
                  } else {
                    // 2. Check Keyword triggers
                    const keywordRules = automations.filter(a => a.trigger_type === 'keyword');
                    const textBody = message.text.body.toLowerCase();
                    for (const rule of keywordRules) {
                      const keywords = rule.trigger_config?.keywords || [];
                      if (keywords.some(kw => textBody.includes(kw.toLowerCase()))) {
                        matchedRule = rule;
                        break;
                      }
                    }
                  }

                  // If a rule matched, fire the auto-reply
                  if (matchedRule && matchedRule.action_config?.message) {
                    const { data: ws } = await supabase.from('workspaces').select('meta_access_token, meta_phone_number_id').eq('id', workspace_id).single();
                    if (ws && ws.meta_access_token && ws.meta_phone_number_id) {
                      const replyText = matchedRule.action_config.message;
                      
                      // Fire request to Meta
                      const payload = {
                        messaging_product: "whatsapp",
                        recipient_type: "individual",
                        to: message.from,
                        type: "text",
                        text: { body: replyText }
                      };
                      
                      const url = `https://graph.facebook.com/v19.0/${ws.meta_phone_number_id}/messages`;
                      const response = await axios.post(url, payload, { 
                        headers: { 'Authorization': `Bearer ${ws.meta_access_token}` } 
                      });

                      // Save outbound message to DB
                      await supabase.from('messages').insert([{
                         workspace_id,
                         phone_number: message.from,
                         message_id: response.data.messages[0].id,
                         direction: 'outbound',
                         type: 'text',
                         content: replyText,
                         status: 'sent'
                      }]);
                      console.log(`[AUTOMATION] Fired auto-reply for rule: ${matchedRule.name}`);
                    }
                  }
                }
              } catch (autoErr) {
                console.error('[AUTOMATION ERROR]', autoErr);
              }
            }
          }
        }
      }
    } 
    // Detect Interakt Payload Format
    else if (payload.type) {
      if (payload.type === 'message_status_update') {
        const { message_id, status, phone_number } = payload.data;
        console.log(`[INTERAKT STATUS] Message ${message_id} to ${phone_number} is now ${status}`);
        // TODO: Update SaaS DB
      } else if (payload.type === 'new_message') {
        const { message_id, text, phone_number } = payload.data;
        console.log(`[INTERAKT INBOUND] Received message from ${phone_number}: ${text}`);
        // TODO: Update SaaS DB
      }
    }

    res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).send('Internal Server Error');
  }
});


// --- ENDPOINTS FOR INBOX UI ---

/**
 * Get Conversations
 */
app.get('/api/whatsapp/conversations', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { workspace_id } = req.query;
  
  if (!workspace_id) {
    return res.status(400).json({ error: 'workspace_id is required' });
  }

  try {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('workspace_id', workspace_id)
      .order('created_at', { ascending: true });
    
    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Delete a specific message
 */
app.delete('/api/messages/:id', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { id } = req.params;
  const { workspace_id } = req.query;
  
  if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required' });

  try {
    const { error } = await supabase.from('messages').delete().eq('id', id).eq('workspace_id', workspace_id);
    if (error) throw error;
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Delete an entire conversation (all messages for a contact)
 */
app.delete('/api/contacts/:phone/messages', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { phone } = req.params;
  const { workspace_id } = req.query;
  
  if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required' });

  try {
    const { error } = await supabase.from('messages').delete().eq('phone_number', phone).eq('workspace_id', workspace_id);
    if (error) throw error;
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting conversation:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Get Workspace Team Members
 */
app.get('/api/workspaces/team', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { workspace_id } = req.query;
  if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required' });

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, role, auth_email:id (email)') // Assuming we can join if needed, but we'll just return what we have
      .eq('workspace_id', workspace_id);
    
    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    console.error('Error fetching team:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Assign Contact to Agent
 */
app.post('/api/contacts/:phone/assign', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { phone } = req.params;
  const { workspace_id, assigned_to } = req.body;
  
  if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required' });

  try {
    const { data, error } = await supabase
      .from('contacts')
      .upsert(
        { phone_number: phone, workspace_id, assigned_to, category: 'Customer' },
        { onConflict: 'phone_number' }
      )
      .select()
      .single();
    
    if (error) throw error;
    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Error assigning contact:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Add Internal Note
 */
app.post('/api/contacts/:phone/notes', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { phone } = req.params;
  const { workspace_id, author_id, note_text } = req.body;
  
  if (!workspace_id || !author_id || !note_text) {
    return res.status(400).json({ error: 'workspace_id, author_id, and note_text are required' });
  }

  try {
    // Ensure contact exists first to avoid foreign key constraints
    await supabase.from('contacts').upsert(
      { phone_number: phone, workspace_id },
      { onConflict: 'phone_number', ignoreDuplicates: true }
    );

    const { data, error } = await supabase
      .from('internal_notes')
      .insert([{
        contact_phone: phone,
        workspace_id,
        author_id,
        note_text
      }])
      .select()
      .single();
    
    if (error) throw error;
    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Error adding note:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Get Internal Notes for a Contact
 */
app.get('/api/contacts/:phone/notes', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { phone } = req.params;
  const { workspace_id } = req.query;
  
  if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required' });

  try {
    const { data, error } = await supabase
      .from('internal_notes')
      .select('*, author:profiles(full_name)')
      .eq('contact_phone', phone)
      .eq('workspace_id', workspace_id)
      .order('created_at', { ascending: true });
    
    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    console.error('Error fetching notes:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Update Workspace Meta Credentials
 */
app.post('/api/workspaces/update', async (req, res) => {
  try {
    const { workspace_id, meta_access_token, meta_phone_number_id, meta_waba_id } = req.body;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required' });

    const updatePayload = { meta_access_token, meta_phone_number_id };
    if (meta_waba_id) updatePayload.meta_waba_id = meta_waba_id;

    const { error } = await supabase
      .from('workspaces')
      .update(updatePayload)
      .eq('id', workspace_id);
    
    if (error) throw error;
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error updating workspace:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * OAuth Token Exchange - Called after Facebook Embedded Signup
 * Receives user access token, exchanges it, fetches WABA/phone details, saves to workspace
 */
app.post('/api/workspaces/oauth', async (req, res) => {
  try {
    const { workspace_id, access_token, phone_number_id, waba_id } = req.body;
    if (!workspace_id || !access_token) {
      return res.status(400).json({ error: 'workspace_id and access_token are required' });
    }

    const appId = process.env.VITE_FACEBOOK_APP_ID || process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;

    let finalPhoneNumberId = phone_number_id;
    let finalWabaId = waba_id;
    let finalAccessToken = access_token;

    // Step 1: Exchange short-lived token for long-lived token (if app secret is available)
    if (appId && appSecret) {
      try {
        const tokenExchangeRes = await axios.get(
          `https://graph.facebook.com/v21.0/oauth/access_token`,
          {
            params: {
              grant_type: 'fb_exchange_token',
              client_id: appId,
              client_secret: appSecret,
              fb_exchange_token: access_token,
            }
          }
        );
        if (tokenExchangeRes.data.access_token) {
          finalAccessToken = tokenExchangeRes.data.access_token;
        }
      } catch (exchangeErr) {
        console.warn('Token exchange failed, using original token:', exchangeErr.message);
      }
    }

    // Step 2: If phone_number_id and waba_id were not sent directly from Embedded Signup,
    // fetch them from the Meta API using the access token
    if (!finalPhoneNumberId || !finalWabaId) {
      try {
        // Get the user's WhatsApp Business Accounts
        const wabaRes = await axios.get(
          `https://graph.facebook.com/v21.0/me/businesses`,
          { params: { access_token: finalAccessToken, fields: 'id,name,whatsapp_business_accounts' } }
        );

        const businesses = wabaRes.data?.data || [];
        for (const business of businesses) {
          // Get WABAs for this business
          const wabaDRes = await axios.get(
            `https://graph.facebook.com/v21.0/${business.id}/owned_whatsapp_business_accounts`,
            { params: { access_token: finalAccessToken } }
          );
          const wabas = wabaDRes.data?.data || [];
          if (wabas.length > 0) {
            finalWabaId = wabas[0].id;

            // Get phone numbers for this WABA
            const phoneRes = await axios.get(
              `https://graph.facebook.com/v21.0/${finalWabaId}/phone_numbers`,
              { params: { access_token: finalAccessToken } }
            );
            const phones = phoneRes.data?.data || [];
            if (phones.length > 0) {
              finalPhoneNumberId = phones[0].id;
            }
            break;
          }
        }
      } catch (fetchErr) {
        console.warn('Could not auto-fetch WABA/phone details:', fetchErr.message);
      }
    }

    // Step 3: Save to workspace
    const updatePayload = {
      meta_access_token: finalAccessToken,
    };
    if (finalPhoneNumberId) updatePayload.meta_phone_number_id = finalPhoneNumberId;
    if (finalWabaId) updatePayload.meta_waba_id = finalWabaId;

    const { error: updateError } = await supabase
      .from('workspaces')
      .update(updatePayload)
      .eq('id', workspace_id);

    if (updateError) throw updateError;

    res.status(200).json({
      success: true,
      phone_number_id: finalPhoneNumberId,
      waba_id: finalWabaId,
    });
  } catch (error) {
    console.error('OAuth exchange error:', error);
    res.status(500).json({ error: 'Failed to complete OAuth setup', details: error.message });
  }
});

// Health Check Endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'WhatsApp multi-provider proxy is running' });
});


// --- ADVANCED CRM & CONTACT MANAGEMENT ---

/**
 * Get All Contacts for Workspace
 */
app.get('/api/contacts', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { workspace_id } = req.query;
  
  if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required' });

  try {
    const { data, error } = await supabase
      .from('contacts')
      .select('*, assigned_to_profile:profiles(full_name)')
      .eq('workspace_id', workspace_id)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Update Contact
 */
app.patch('/api/contacts/:phone', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { phone } = req.params;
  const { workspace_id, name, email, tags, custom_attributes, category } = req.body;
  
  if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required' });

  const updateData = {};
  if (name !== undefined) updateData.name = name;
  if (email !== undefined) updateData.email = email;
  if (tags !== undefined) updateData.tags = tags;
  if (custom_attributes !== undefined) updateData.custom_attributes = custom_attributes;
  if (category !== undefined) updateData.category = category;

  try {
    const { data, error } = await supabase
      .from('contacts')
      .update(updateData)
      .eq('phone_number', phone)
      .eq('workspace_id', workspace_id)
      .select()
      .single();
    
    if (error) throw error;
    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Error updating contact:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } }); // 16MB limit

/**
 * Import Contacts via CSV
 */
app.post('/api/contacts/import', upload.single('file'), async (req, res) => {
  // ... (import logic is already here)
}); // End of import Contacts

/**
 * Sync Meta Templates
 */
app.get('/api/meta/templates/sync', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { workspace_id } = req.query;
  
  if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required' });

  try {
    const { data: ws } = await supabase.from('workspaces').select('meta_waba_id, meta_access_token').eq('id', workspace_id).single();
    if (!ws || !ws.meta_waba_id || !ws.meta_access_token) {
      return res.status(400).json({ error: 'WhatsApp Business Account ID (WABA ID) and Access Token are required in Setup.' });
    }

    const response = await axios.get(`https://graph.facebook.com/v19.0/${ws.meta_waba_id}/message_templates?limit=100`, {
      headers: { 'Authorization': `Bearer ${ws.meta_access_token}` }
    });

    const metaTemplates = response.data.data;
    let upsertCount = 0;

    for (const t of metaTemplates) {
      const { data: existing } = await supabase
        .from('templates')
        .select('id')
        .eq('workspace_id', workspace_id)
        .eq('name', t.name)
        .eq('language', t.language)
        .single();
        
      if (existing) {
        await supabase.from('templates').update({
          category: t.category,
          components: t.components,
          status: t.status,
          meta_template_id: t.id
        }).eq('id', existing.id);
      } else {
        await supabase.from('templates').insert([{
          workspace_id,
          name: t.name,
          language: t.language,
          category: t.category,
          components: t.components,
          status: t.status,
          meta_template_id: t.id
        }]);
      }
      upsertCount++;
    }

    res.status(200).json({ success: true, count: upsertCount });
  } catch (error) {
    console.error('Error syncing templates:', error.response?.data || error.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Create Meta Template
 */
app.post('/api/meta/templates', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { workspace_id, name, language, category, components } = req.body;
  
  if (!workspace_id || !name || !language || !category || !components) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const { data: ws } = await supabase.from('workspaces').select('meta_waba_id, meta_access_token').eq('id', workspace_id).single();
    if (!ws || !ws.meta_waba_id || !ws.meta_access_token) {
      return res.status(400).json({ error: 'WhatsApp Business Account ID (WABA ID) and Access Token are required in Setup.' });
    }

    // Submit to Meta
    const response = await axios.post(`https://graph.facebook.com/v19.0/${ws.meta_waba_id}/message_templates`, {
      name,
      language,
      category,
      components
    }, {
      headers: { 'Authorization': `Bearer ${ws.meta_access_token}` }
    });

    const meta_template_id = response.data.id;
    
    // Save to database as PENDING
    const { data, error } = await supabase.from('templates').insert([{
      workspace_id,
      name,
      language,
      category,
      components,
      status: 'PENDING',
      meta_template_id
    }]).select().single();
    
    if (error) throw error;
    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Error creating template:', error.response?.data?.error || error.message);
    res.status(500).json({ error: error.response?.data?.error?.message || 'Internal Server Error' });
  }
});

/**
 * Get Saved Templates
 */
app.get('/api/templates', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { workspace_id } = req.query;
  
  if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required' });

  try {
    const { data, error } = await supabase
      .from('templates')
      .select('*')
      .eq('workspace_id', workspace_id)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Launch Campaign
 */
app.post('/api/campaigns/:id/launch', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { id } = req.params;
  const { workspace_id, variable_mapping } = req.body;

  if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required' });

  try {
    const { data: campaign } = await supabase.from('campaigns').select('*, templates(*)').eq('id', id).eq('workspace_id', workspace_id).single();
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    
    if (campaign.status !== 'DRAFT') {
      return res.status(400).json({ error: 'Campaign has already been launched.' });
    }

    const { data: ws } = await supabase.from('workspaces').select('meta_access_token, meta_phone_number_id').eq('id', workspace_id).single();
    if (!ws || !ws.meta_access_token) return res.status(400).json({ error: 'Meta token missing.' });

    // Mark as SENDING
    await supabase.from('campaigns').update({ status: 'SENDING' }).eq('id', id);

    // Fetch Audience
    let query = supabase.from('contacts').select('*').eq('workspace_id', workspace_id);
    if (campaign.audience_tags && campaign.audience_tags.length > 0) {
      query = query.contains('tags', campaign.audience_tags);
    }
    const { data: audience } = await query;
    
    if (!audience || audience.length === 0) {
      await supabase.from('campaigns').update({ status: 'COMPLETED' }).eq('id', id);
      return res.status(400).json({ error: 'Audience is empty based on selected tags.' });
    }

    res.status(200).json({ success: true, message: `Campaign launched to ${audience.length} contacts.` });

    // BACKGROUND PROCESSING (Simple Promise Loop for MVP)
    (async () => {
      let sentCount = 0;
      let failedCount = 0;
      
      for (const contact of audience) {
        // Construct message parameters based on mapping
        // variable_mapping: { "1": "name", "2": "custom_attributes.order_id" }
        const parameters = [];
        if (variable_mapping) {
          for (const key of Object.keys(variable_mapping).sort()) {
            const attrPath = variable_mapping[key];
            let value = '';
            if (attrPath === 'name') value = contact.name || '';
            else if (attrPath.startsWith('custom_attributes.')) {
              const attrKey = attrPath.replace('custom_attributes.', '');
              value = (contact.custom_attributes && contact.custom_attributes[attrKey]) || '';
            }
            parameters.push({ type: 'text', text: value });
          }
        }

        const payload = {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: contact.phone_number,
          type: "template",
          template: {
            name: campaign.templates.name,
            language: { code: campaign.templates.language },
            components: parameters.length > 0 ? [{ type: "body", parameters }] : []
          }
        };

        try {
          const url = `https://graph.facebook.com/v19.0/${ws.meta_phone_number_id}/messages`;
          const response = await axios.post(url, payload, { 
            headers: { 'Authorization': `Bearer ${ws.meta_access_token}` } 
          });

          sentCount++;
          const messageId = response.data.messages[0].id;
          
          await supabase.from('campaign_logs').insert([{
             campaign_id: id,
             workspace_id,
             contact_phone: contact.phone_number,
             status: 'sent',
             message_id: messageId
          }]);
          
          // Also track in general messages table
          await supabase.from('messages').insert([{
             workspace_id,
             phone_number: contact.phone_number,
             message_id: messageId,
             direction: 'outbound',
             type: 'template',
             content: `Campaign: ${campaign.name} (${campaign.templates.name})`,
             status: 'sent'
          }]);

        } catch (err) {
          failedCount++;
          await supabase.from('campaign_logs').insert([{
             campaign_id: id,
             workspace_id,
             contact_phone: contact.phone_number,
             status: 'failed',
             error_message: err.response?.data?.error?.message || err.message
          }]);
        }
        
        // Basic throttling (Wait 50ms between requests)
        await new Promise(r => setTimeout(r, 50));
      }

      await supabase.from('campaigns').update({
        status: 'COMPLETED',
        analytics: { sent: sentCount, delivered: 0, read: 0, failed: failedCount }
      }).eq('id', id);

    })();

  } catch (error) {
    console.error('Error launching campaign:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Create Campaign
 */
app.post('/api/campaigns', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { workspace_id, name, template_id, audience_tags } = req.body;

  if (!workspace_id || !name || !template_id) return res.status(400).json({ error: 'Missing required fields' });

  try {
    const { data, error } = await supabase.from('campaigns').insert([{
      workspace_id, name, template_id, audience_tags
    }]).select().single();
    if (error) throw error;
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get Campaigns
 */
app.get('/api/campaigns', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { workspace_id } = req.query;
  
  try {
    const { data, error } = await supabase.from('campaigns').select('*, templates(*)').eq('workspace_id', workspace_id).order('created_at', { ascending: false });
    if (error) throw error;
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get Campaign Logs
 */
app.get('/api/campaigns/:id/logs', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { id } = req.params;
  const { workspace_id } = req.query;
  
  try {
    const { data, error } = await supabase.from('campaign_logs').select('*').eq('campaign_id', id).eq('workspace_id', workspace_id).order('created_at', { ascending: false });
    if (error) throw error;
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- AUTOMATION ENDPOINTS ---

/**
 * Get Automations
 */
app.get('/api/automations', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { workspace_id } = req.query;
  
  try {
    const { data, error } = await supabase.from('automations').select('*').eq('workspace_id', workspace_id).order('created_at', { ascending: false });
    if (error) throw error;
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Create Automation
 */
app.post('/api/automations', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { workspace_id, name, trigger_type, trigger_config, action_config, is_active } = req.body;

  try {
    const { data, error } = await supabase.from('automations').insert([{
      workspace_id, name, trigger_type, trigger_config, action_config, is_active
    }]).select().single();
    if (error) throw error;
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Update Automation
 */
app.put('/api/automations/:id', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { id } = req.params;
  
  try {
    const { data, error } = await supabase.from('automations').update(req.body).eq('id', id).select().single();
    if (error) throw error;
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Delete Automation
 */
app.delete('/api/automations/:id', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { id } = req.params;
  
  try {
    const { error } = await supabase.from('automations').delete().eq('id', id);
    if (error) throw error;
    res.status(200).json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contacts/import', multer().single('file'), async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { workspace_id } = req.body;
  const file = req.file;

  if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required' });
  if (!file) return res.status(400).json({ error: 'CSV file is required' });

  const results = [];
  const bufferStream = new stream.PassThrough();
  bufferStream.end(file.buffer);

  bufferStream
    .pipe(csv())
    .on('data', (data) => results.push(data))
    .on('end', async () => {
      let successCount = 0;
      let errorCount = 0;
      
      for (const row of results) {
        let phone = row.phone || row.phone_number || row.phoneNumber || row.Phone;
        if (!phone) {
          errorCount++;
          continue;
        }
        
        // Clean phone number (digits only)
        phone = phone.replace(/\D/g, '');

        const name = row.name || row.Name || row.full_name;
        const email = row.email || row.Email;
        const tagsRaw = row.tags || row.Tags;
        const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()) : [];
        
        // Collect extra fields as custom attributes
        const custom_attributes = { ...row };
        delete custom_attributes.phone;
        delete custom_attributes.phone_number;
        delete custom_attributes.phoneNumber;
        delete custom_attributes.Phone;
        delete custom_attributes.name;
        delete custom_attributes.Name;
        delete custom_attributes.full_name;
        delete custom_attributes.email;
        delete custom_attributes.Email;
        delete custom_attributes.tags;
        delete custom_attributes.Tags;

        try {
          const { error } = await supabase
            .from('contacts')
            .upsert({ 
              phone_number: phone, 
              workspace_id,
              name: name || null,
              email: email || null,
              tags,
              custom_attributes,
              category: 'Lead' // Default category
            }, { onConflict: 'phone_number' });

          if (error) {
            console.error('Error upserting row:', error);
            errorCount++;
          } else {
            successCount++;
          }
        } catch (err) {
          errorCount++;
        }
      }

      res.status(200).json({ 
        success: true, 
        message: `Imported ${successCount} contacts. ${errorCount} failed.` 
      });
    });
});

/**
 * Send Free-form text Reply (Outbound) or Media Message
 */
app.post('/api/whatsapp/send', upload.single('file'), async (req, res) => {
  try {
    const { phoneNumber, message, workspace_id, messageType: reqMessageType, interactive, location } = req.body;
    const file = req.file;
    
    if (!phoneNumber && !message && !file && !interactive && !location) {
      return res.status(400).json({ error: 'phoneNumber and message or file or interactive/location are required' });
    }
    if (!workspace_id) {
      return res.status(400).json({ error: 'workspace_id is required' });
    }

    // Fetch dynamic tokens from DB
    const { data: ws } = await supabase.from('workspaces').select('*').eq('id', workspace_id).single();
    if (!ws) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    const accessToken = ws.meta_access_token;
    const phoneNumberId = ws.meta_phone_number_id;

    if (!phoneNumberId || !accessToken) {
      return res.status(500).json({ error: 'Meta credentials missing for this workspace' });
    }

    let mediaId = null;
    let messageType = reqMessageType || 'text';

    // If there is a file, upload it to Meta first
    if (file) {
      const formData = new FormData();
      formData.append('file', file.buffer, {
        filename: file.originalname,
        contentType: file.mimetype,
      });
      formData.append('messaging_product', 'whatsapp');

      const mediaUrl = `https://graph.facebook.com/v19.0/${phoneNumberId}/media`;
      const mediaResponse = await axios.post(mediaUrl, formData, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          ...formData.getHeaders(),
        }
      });
      
      mediaId = mediaResponse.data.id;
      messageType = file.mimetype.startsWith('image/') ? 'image' : 'document';
    }

    // Prepare payload
    let payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phoneNumber,
      type: messageType,
    };

    if (messageType === 'text') {
      payload.text = { preview_url: false, body: message };
    } else if (messageType === 'image') {
      payload.image = { id: mediaId };
      if (message) payload.image.caption = message; // Add caption if message exists
    } else if (messageType === 'document') {
      payload.document = { id: mediaId, filename: file.originalname };
      if (message) payload.document.caption = message; // Some versions support caption for doc
    } else if (messageType === 'interactive') {
      let parsedInteractive = interactive;
      if (typeof interactive === 'string') parsedInteractive = JSON.parse(interactive);
      payload.interactive = parsedInteractive;
    } else if (messageType === 'location') {
      let parsedLocation = location;
      if (typeof location === 'string') parsedLocation = JSON.parse(location);
      payload.location = parsedLocation;
    }

    const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;
    const response = await axios.post(url, payload, { headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }});

    if (supabase && response.data.messages && response.data.messages.length > 0) {
      const messageId = response.data.messages[0].id;
      
      let finalContent = message || '';
      if (messageType === 'document') {
         finalContent = `[FILENAME]${file.originalname}[/FILENAME]${message || ''}`;
      } else if (messageType === 'interactive') {
         finalContent = '[Interactive Sent]';
      } else if (messageType === 'location') {
         let parsed = typeof location === 'string' ? JSON.parse(location) : location;
         finalContent = `[LOCATION] ${parsed.latitude},${parsed.longitude} - ${parsed.name || ''}`;
      }

      const insertData = {
        workspace_id: workspace_id,
        phone_number: phoneNumber,
        message_id: messageId,
        direction: 'outbound',
        type: messageType,
        content: finalContent,
        status: 'sent',
      };
      if (mediaId) insertData.media_id = mediaId;
      
      const { error } = await supabase.from('messages').insert([insertData]);
      if (error) {
         delete insertData.profile_name;
         await supabase.from('messages').insert([insertData]); // fallback
      }
    }

    return res.status(200).json({ success: true, data: response.data });
  } catch (error) {
    console.error('Error sending reply:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || 'Internal Server Error' });
  }
});

/**
 * Proxy Media from Meta (Stickers, Images)
 */
app.get('/api/whatsapp/media/:mediaId', async (req, res) => {
  try {
    const { mediaId } = req.params;
    const { workspace_id } = req.query;
    
    if (!workspace_id) return res.status(400).send('workspace_id is required');
    
    const { data: ws } = await supabase.from('workspaces').select('meta_access_token').eq('id', workspace_id).single();
    if (!ws || !ws.meta_access_token) return res.status(500).send('Missing Meta access token for this workspace');
    const accessToken = ws.meta_access_token;

    // 1. Get media URL from Meta
    const urlResponse = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const mediaUrl = urlResponse.data.url;
    const mimeType = urlResponse.data.mime_type;

    // 2. Download and pipe directly to frontend
    const mediaResponse = await axios.get(mediaUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      responseType: 'stream'
    });

    res.setHeader('Content-Type', mimeType);
    mediaResponse.data.pipe(res);
  } catch (error) {
    console.error('Error fetching media:', error.response?.data || error.message);
    res.status(500).send('Error fetching media');
  }
});

// Start Server (Only if not in Vercel environment)
if (process.env.VERCEL_ENV !== 'production' && process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

module.exports = app;
