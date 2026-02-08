import '@rainbow-me/rainbowkit/styles.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { getDefaultConfig, RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { WagmiProvider } from 'wagmi';
import { bsc } from 'wagmi/chains';
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import {
  metaMaskWallet,
  okxWallet,
  tokenPocketWallet
} from '@rainbow-me/rainbowkit/wallets';

const config = getDefaultConfig({
  appName: '4craft',
  projectId: 'YOUR_PROJECT_ID', // Get one at https://cloud.reown.com
  chains: [bsc],
  wallets: [
    {
      groupName: 'Recommended',
      wallets: [metaMaskWallet, okxWallet, tokenPocketWallet],
    },
  ],
});

const queryClient = new QueryClient();

const customTheme = darkTheme({
  accentColor: '#FCEE09',
  accentColorForeground: 'black',
  borderRadius: 'medium',
  fontStack: 'system',
  overlayBlur: 'small',
});

// Customizing theme to match Cyberpunk look
customTheme.colors.modalBackground = '#050505';
customTheme.colors.modalBorder = 'rgba(255, 255, 255, 0.1)';
customTheme.colors.profileAction = 'rgba(255, 255, 255, 0.05)';
customTheme.colors.profileActionHover = 'rgba(255, 255, 255, 0.1)';
customTheme.shadows.dialog = '0 0 50px rgba(252, 238, 9, 0.15)';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={customTheme} modalSize="compact">
          <App />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>
);
