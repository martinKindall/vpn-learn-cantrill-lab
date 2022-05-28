#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SiteToSiteVpnStack } from '../lib/site-to-site-vpn-stack';

const app = new cdk.App();
new SiteToSiteVpnStack(app, 'SiteToSiteVpnStack');
