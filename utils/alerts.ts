import { logger } from '../helpers/logger';
import { ENABLE_ALERTS, WEBHOOK_URL } from './constants';
import axios from 'axios';

export interface AlertData {
  type: 'buy' | 'sell' | 'error';
  mint: string;
  symbol?: string;
  price?: number;
  amount?: string;
  pnl?: number;
  pnlPercent?: number;
  reason?: string;
  signature?: string;
  message: string;
}

export class AlertManager {
  public async sendAlert(data: AlertData): Promise<void> {
    if (!ENABLE_ALERTS || !WEBHOOK_URL) {
      return;
    }

    try {
      const payload = {
        content: this.formatAlert(data),
        embeds: [{
          title: `${data.type.toUpperCase()} Alert`,
          description: data.message,
          color: this.getColor(data.type),
          fields: this.getFields(data),
          timestamp: new Date().toISOString()
        }]
      };

      await axios.post(WEBHOOK_URL, payload, {
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json'
        }
      });

      logger.trace({ type: data.type, mint: data.mint }, 'ALERT -> Sent successfully');

    } catch (error: any) {
      logger.error({ error: error.message }, 'ALERT -> Failed to send');
    }
  }

  private formatAlert(data: AlertData): string {
    const emoji = data.type === 'buy' ? '🟢' : data.type === 'sell' ? '🔴' : '⚠️';
    return `${emoji} **${data.type.toUpperCase()}** - ${data.symbol || data.mint.slice(0, 8)}`;
  }

  private getColor(type: string): number {
    switch (type) {
      case 'buy': return 0x00ff00; // Green
      case 'sell': return 0xff0000; // Red
      case 'error': return 0xffff00; // Yellow
      default: return 0x808080; // Gray
    }
  }

  private getFields(data: AlertData): any[] {
    const fields = [
      { name: 'Token', value: data.mint, inline: true }
    ];

    if (data.symbol) {
      fields.push({ name: 'Symbol', value: data.symbol, inline: true });
    }

    if (data.price) {
      fields.push({ name: 'Price', value: data.price.toString(), inline: true });
    }

    if (data.amount) {
      fields.push({ name: 'Amount', value: data.amount, inline: true });
    }

    if (data.pnl !== undefined) {
      fields.push({ 
        name: 'PnL', 
        value: `${data.pnl.toFixed(4)} (${data.pnlPercent?.toFixed(2)}%)`, 
        inline: true 
      });
    }

    if (data.reason) {
      fields.push({ name: 'Reason', value: data.reason, inline: true });
    }

    if (data.signature) {
      fields.push({ 
        name: 'Transaction', 
        value: `[View](https://solscan.io/tx/${data.signature})`, 
        inline: true 
      });
    }

    return fields;
  }
}