import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  {
    path: 'dashboard',
    title: 'Dashboard · PulseTrade',
    loadComponent: () => import('./dashboard/dashboard').then((m) => m.Dashboard),
  },
  {
    path: 'settings',
    title: 'Settings · PulseTrade',
    loadComponent: () => import('./settings/settings').then((m) => m.Settings),
  },
  { path: '**', redirectTo: 'dashboard' },
];
