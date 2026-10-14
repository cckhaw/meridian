'use client';
import { useApi } from './api';

/** Whether Settings → Markets has several markets switched on. While it loads this is false, so market fields never flash up on a one-market CRM. */
export function useMultiMarket(): boolean {
  return useApi<{ multiMarket?: boolean }>('/meta').data?.multiMarket === true;
}
