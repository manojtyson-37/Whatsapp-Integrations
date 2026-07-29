import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { toast } from 'react-hot-toast';

const EmbeddedSignup = ({ workspaceId, onSetupComplete }) => {
  const [isSdkLoaded, setIsSdkLoaded] = useState(false);
  const [isLinking, setIsLinking] = useState(false);

  useEffect(() => {
    // Listen for the Embedded Signup message from Meta's popup
    const handleMessage = (event) => {
      if (event.origin !== 'https://www.facebook.com' && event.origin !== 'https://web.facebook.com') return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'WA_EMBEDDED_SIGNUP') {
          if (data.event === 'FINISH') {
            const { phone_number_id, waba_id } = data.data;
            // Get the access token from the FB auth response and exchange with backend
            window.FB.getLoginStatus((statusResponse) => {
              if (statusResponse.status === 'connected') {
                exchangeTokenWithBackend(statusResponse.authResponse.accessToken, phone_number_id, waba_id);
              } else {
                toast.error('Could not retrieve access token after signup.');
                setIsLinking(false);
              }
            });
          } else if (data.event === 'CANCEL') {
            setIsLinking(false);
            toast.error('Setup was cancelled.');
          } else if (data.event === 'ERROR') {
            setIsLinking(false);
            toast.error('An error occurred during setup: ' + (data.data?.error_message || 'Unknown error'));
          }
        }
      } catch (e) {
        // Not a JSON message or not from Meta, ignore
      }
    };

    window.addEventListener('message', handleMessage);

    // Load the Facebook SDK
    const loadFbSdk = () => {
      window.fbAsyncInit = function() {
        window.FB.init({
          appId  : import.meta.env.VITE_FACEBOOK_APP_ID || '',
          cookie : true,
          xfbml  : true,
          version: 'v21.0'
        });
        setIsSdkLoaded(true);
      };

      (function(d, s, id) {
        var js, fjs = d.getElementsByTagName(s)[0];
        if (d.getElementById(id)) return;
        js = d.createElement(s); js.id = id;
        js.src = 'https://connect.facebook.net/en_US/sdk.js';
        fjs.parentNode.insertBefore(js, fjs);
      }(document, 'script', 'facebook-jssdk'));
    };

    if (!window.FB) {
      loadFbSdk();
    } else {
      setIsSdkLoaded(true);
    }

    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleFacebookLogin = () => {
    if (!window.FB) {
      toast.error('Facebook SDK not loaded yet. Please try again.');
      return;
    }

    setIsLinking(true);

    const configId = import.meta.env.VITE_FACEBOOK_CONFIG_ID;

    if (configId) {
      // Full Embedded Signup flow with Tech Provider Config ID (like WATI/Interakt)
      // This opens a Meta-hosted popup where the client registers their WhatsApp number
      window.FB.login((response) => {
        if (!response.authResponse) {
          setIsLinking(false);
          toast.error('Login cancelled or failed.');
        }
        // The actual phone_number_id and waba_id come via the postMessage listener above
      }, {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: {
          setup: {},
          featureType: '',
          sessionInfoVersion: '3',
        }
      });
    } else {
      // Fallback: standard FB login with WhatsApp permissions
      window.FB.login((response) => {
        if (response.authResponse) {
          exchangeTokenWithBackend(response.authResponse.accessToken, null, null);
        } else {
          setIsLinking(false);
          toast.error('Login cancelled.');
        }
      }, {
        scope: 'whatsapp_business_management,whatsapp_business_messaging',
        return_scopes: true
      });
    }
  };

  const exchangeTokenWithBackend = async (accessToken, phoneNumberId, wabaId) => {
    const backendUrl = import.meta.env.VITE_BACKEND_URL || (import.meta.env.DEV ? 'http://localhost:3000' : '');
    
    try {
      const res = await axios.post(`${backendUrl}/api/workspaces/oauth`, {
        workspace_id: workspaceId,
        access_token: accessToken,
        ...(phoneNumberId && { phone_number_id: phoneNumberId }),
        ...(wabaId && { waba_id: wabaId }),
      });

      if (res.data.success) {
        toast.success('Successfully linked WhatsApp Business Account!');
        if (onSetupComplete) onSetupComplete();
      } else {
        toast.error(res.data.error || 'Failed to complete setup.');
        setIsLinking(false);
      }
    } catch (err) {
      console.error('OAuth Exchange Error:', err);
      toast.error(err.response?.data?.error || 'Failed to connect to backend.');
      setIsLinking(false);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-8 text-center shadow-sm">
      <div className="mx-auto w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mb-4">
        <svg className="w-8 h-8 text-blue-600" fill="currentColor" viewBox="0 0 24 24">
          <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
        </svg>
      </div>
      <h3 className="text-xl font-semibold text-gray-900 mb-2">Connect your WhatsApp</h3>
      <p className="text-gray-500 mb-8 max-w-md mx-auto">
        No more confusing API tokens. Just log in with Facebook to automatically connect your WhatsApp Business account.
      </p>

      {!import.meta.env.VITE_FACEBOOK_APP_ID ? (
        <div className="bg-yellow-50 text-yellow-800 p-4 rounded-lg text-sm text-left mb-6">
          <strong>Setup Required:</strong> You need to add `VITE_FACEBOOK_APP_ID` to your frontend `.env` file to enable Embedded Signup.
        </div>
      ) : null}

      <button
        onClick={handleFacebookLogin}
        disabled={!isSdkLoaded || isLinking}
        className={`inline-flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-lg text-white transition-colors
          ${(!isSdkLoaded || isLinking) ? 'bg-blue-400 cursor-not-allowed' : 'bg-[#1877F2] hover:bg-[#166fe5] shadow-sm'}
        `}
      >
        {isLinking ? (
          <span className="flex items-center gap-2">
            <svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            Connecting...
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
            </svg>
            Log in with Facebook
          </span>
        )}
      </button>
      
      <p className="mt-4 text-xs text-gray-400">
        By connecting, you grant us permission to manage your WhatsApp Business messages.
      </p>
    </div>
  );
};

export default EmbeddedSignup;
