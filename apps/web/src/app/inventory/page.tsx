'use client';
import { LargeTitle, Segmented } from '@meridian/ui';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { StockTab } from './stock-tab';
import { HistoryTab } from './history-tab';
import { WarehousesTab } from './warehouses-tab';
import { TransfersTab } from './transfers-tab';

type Tab = 'stock' | 'transfers' | 'warehouses' | 'history';

/** Everything about stock: what is on hand where, the warehouse locations, and the history of every receipt and write-off. */
export default function Inventory() {
  const { can, me } = useAuth();
  const [tab, setTab] = useState<Tab>('stock');
  const options = [{ value: 'stock' as Tab, label: 'Stock' }, { value: 'transfers' as Tab, label: 'Transfers' }, ...(me?.storeId ? [] : [{ value: 'warehouses' as Tab, label: 'Warehouses' }]), { value: 'history' as Tab, label: 'History' }];
  return (
    <>
      <LargeTitle subtitle="On-hand, reserved and available stock by location; receipts, write-offs, transfers between stores and warehouses.">Inventory</LargeTitle>
      <div className="mb-4"><Segmented label="Inventory view" value={tab} options={options} onChange={setTab} /></div>
      {tab === 'stock' && <StockTab />}
      {tab === 'transfers' && <TransfersTab canTransfer={can('inventory:transfer')} />}
      {tab === 'warehouses' && <WarehousesTab canManage={can('warehouse:manage')} />}
      {tab === 'history' && <HistoryTab />}
    </>
  );
}
