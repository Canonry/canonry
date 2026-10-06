import { describe, expect, it } from 'vitest'
import {
  GoogleAdsClient,
} from '../src/index.js'
import type {
  GoogleAdsCampaign,
  GoogleAdsConversionAction,
  GoogleAdsFetch,
} from '../src/index.js'

const campaignCustomerGoals: GoogleAdsCampaign = {
  resourceName: 'customers/1234567890/campaigns/100',
  id: '100',
  name: 'Customer goals campaign',
  status: 'ENABLED',
}

const campaignCustomGoal: GoogleAdsCampaign = {
  resourceName: 'customers/1234567890/campaigns/200',
  id: '200',
  name: 'Custom goal campaign',
  status: 'ENABLED',
}

const purchaseAction: GoogleAdsConversionAction = {
  resourceName: 'customers/1234567890/conversionActions/1',
  id: '1',
  name: 'Purchase',
  status: 'ENABLED',
  type: 'WEBPAGE',
  category: 'PURCHASE',
  origin: 'WEBSITE',
  primaryForGoal: true,
}

const checkoutAction: GoogleAdsConversionAction = {
  resourceName: 'customers/1234567890/conversionActions/2',
  id: '2',
  name: 'Checkout details complete',
  status: 'ENABLED',
  type: 'WEBPAGE',
  category: 'BEGIN_CHECKOUT',
  origin: 'WEBSITE',
  primaryForGoal: false,
}

const goalResponses = {
    conversionActions: [
      { conversionAction: purchaseAction },
      { conversionAction: checkoutAction },
    ],
    customerGoals: [
      {
        customerConversionGoal: {
          resourceName: 'customers/1234567890/customerConversionGoals/PURCHASE~WEBSITE',
          category: 'PURCHASE',
          origin: 'WEBSITE',
          biddable: true,
        },
      },
      {
        customerConversionGoal: {
          resourceName: 'customers/1234567890/customerConversionGoals/BEGIN_CHECKOUT~WEBSITE',
          category: 'BEGIN_CHECKOUT',
          origin: 'WEBSITE',
          biddable: false,
        },
      },
    ],
    campaignGoals: [
      {
        campaignConversionGoal: {
          resourceName: 'customers/1234567890/campaignConversionGoals/200~PURCHASE~WEBSITE',
          campaign: campaignCustomGoal.resourceName,
          category: 'PURCHASE',
          origin: 'WEBSITE',
          biddable: false,
        },
        campaign: campaignCustomGoal,
      },
      {
        campaignConversionGoal: {
          resourceName: 'customers/1234567890/campaignConversionGoals/200~BEGIN_CHECKOUT~WEBSITE',
          campaign: campaignCustomGoal.resourceName,
          category: 'BEGIN_CHECKOUT',
          origin: 'WEBSITE',
          biddable: true,
        },
        campaign: campaignCustomGoal,
      },
    ],
    customGoals: [
      {
        customConversionGoal: {
          resourceName: 'customers/1234567890/customConversionGoals/9',
          id: '9',
          name: 'Checkout proxy',
          status: 'ENABLED',
          conversionActions: [
            checkoutAction.resourceName,
            'customers/1234567890/conversionActions/999',
          ],
        },
      },
    ],
    campaignConfigs: [
      {
        conversionGoalCampaignConfig: {
          resourceName: 'customers/1234567890/conversionGoalCampaignConfigs/100',
          campaign: campaignCustomerGoals.resourceName,
          goalConfigLevel: 'CUSTOMER' as const,
        },
        campaign: campaignCustomerGoals,
      },
      {
        conversionGoalCampaignConfig: {
          resourceName: 'customers/1234567890/conversionGoalCampaignConfigs/200',
          campaign: campaignCustomGoal.resourceName,
          goalConfigLevel: 'CAMPAIGN' as const,
          customConversionGoal: 'customers/1234567890/customConversionGoals/9',
        },
        campaign: campaignCustomGoal,
      },
    ],
}

describe('GoogleAdsClient goal input composite', () => {
  it('retrieves every goal layer and returns request provenance', async () => {
    const requests: { url: string; method: string | undefined; headers: Record<string, string>; query: string; resource: string }[] = []
    const fetch: GoogleAdsFetch = async (input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { query: string }
      const resource = /FROM ([a-z_]+)/.exec(body.query)?.[1]
      if (!resource) throw new Error('Missing GAQL resource')
      requests.push({
        url: String(input), method: init?.method,
        headers: Object.fromEntries(new Headers(init?.headers)),
        query: body.query.replace(/\s+/g, ' ').trim(), resource,
      })
      const results = resource === 'conversion_action'
        ? goalResponses.conversionActions
        : resource === 'customer_conversion_goal'
          ? goalResponses.customerGoals
          : resource === 'campaign_conversion_goal'
            ? goalResponses.campaignGoals
            : resource === 'custom_conversion_goal'
              ? goalResponses.customGoals
              : resource === 'conversion_goal_campaign_config'
                ? goalResponses.campaignConfigs
                : []
      return new Response(JSON.stringify([{ results, requestId: `req-${resource}` }]), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    const client = new GoogleAdsClient({
      accessToken: 'access-token', developerToken: 'developer-token', loginCustomerId: '999-888-7777',
    }, { fetch })

    const result = await client.getConversionGoals('123-456-7890')

    expect(requests.map(request => request.resource).sort()).toEqual([
      'campaign_conversion_goal', 'conversion_action', 'conversion_goal_campaign_config',
      'custom_conversion_goal', 'customer_conversion_goal',
    ])
    for (const request of requests) {
      expect(request.url).toBe('https://googleads.googleapis.com/v25/customers/1234567890/googleAds:searchStream')
      expect(request.method).toBe('POST')
      expect(request.headers).toEqual({
        authorization: 'Bearer access-token', 'content-type': 'application/json',
        'developer-token': 'developer-token', 'login-customer-id': '9998887777',
      })
    }
    expect(Object.fromEntries(requests.map(({ resource, query }) => [resource, query]))).toEqual({
      conversion_action: 'SELECT conversion_action.resource_name, conversion_action.id, conversion_action.name, '
      + 'conversion_action.status, conversion_action.type, conversion_action.category, conversion_action.origin, '
      + 'conversion_action.owner_customer, conversion_action.primary_for_goal, conversion_action.include_in_conversions_metric, '
      + 'conversion_action.counting_type, conversion_action.click_through_lookback_window_days, '
      + 'conversion_action.view_through_lookback_window_days, conversion_action.attribution_model_settings.attribution_model, '
      + 'conversion_action.value_settings.always_use_default_value, conversion_action.value_settings.default_currency_code, '
      + 'conversion_action.value_settings.default_value, conversion_action.google_analytics_4_settings.event_name, '
      + 'conversion_action.google_analytics_4_settings.property_id, conversion_action.google_analytics_4_settings.property_name, '
      + 'conversion_action.tag_snippets FROM conversion_action ORDER BY conversion_action.id ASC LIMIT 10000',
      customer_conversion_goal: 'SELECT customer_conversion_goal.resource_name, customer_conversion_goal.category, customer_conversion_goal.origin, '
      + 'customer_conversion_goal.biddable FROM customer_conversion_goal '
      + 'ORDER BY customer_conversion_goal.category ASC, customer_conversion_goal.origin ASC LIMIT 10000',
      campaign_conversion_goal: 'SELECT campaign_conversion_goal.resource_name, campaign_conversion_goal.campaign, campaign_conversion_goal.category, '
      + 'campaign_conversion_goal.origin, campaign_conversion_goal.biddable, campaign.resource_name, campaign.id, campaign.name, '
      + "campaign.status FROM campaign_conversion_goal WHERE campaign.status != 'REMOVED' "
      + 'ORDER BY campaign.id ASC, campaign_conversion_goal.category ASC, campaign_conversion_goal.origin ASC LIMIT 10000',
      custom_conversion_goal: 'SELECT custom_conversion_goal.resource_name, custom_conversion_goal.id, custom_conversion_goal.name, '
      + 'custom_conversion_goal.status, custom_conversion_goal.conversion_actions FROM custom_conversion_goal '
      + 'ORDER BY custom_conversion_goal.id ASC LIMIT 10000',
      conversion_goal_campaign_config: 'SELECT conversion_goal_campaign_config.resource_name, conversion_goal_campaign_config.campaign, '
      + 'conversion_goal_campaign_config.custom_conversion_goal, conversion_goal_campaign_config.goal_config_level, '
      + 'campaign.resource_name, campaign.id, campaign.name, campaign.status '
      + "FROM conversion_goal_campaign_config WHERE campaign.status != 'REMOVED' ORDER BY campaign.id ASC LIMIT 10000",
    })
    expect(result.data).toEqual({
      conversionActions: [
        { conversionAction: {
          resourceName: 'customers/1234567890/conversionActions/1', id: '1', name: 'Purchase',
          status: 'ENABLED', type: 'WEBPAGE', category: 'PURCHASE', origin: 'WEBSITE', primaryForGoal: true,
        } },
        { conversionAction: {
          resourceName: 'customers/1234567890/conversionActions/2', id: '2', name: 'Checkout details complete',
          status: 'ENABLED', type: 'WEBPAGE', category: 'BEGIN_CHECKOUT', origin: 'WEBSITE', primaryForGoal: false,
        } },
      ],
      customerGoals: [
        { customerConversionGoal: {
          resourceName: 'customers/1234567890/customerConversionGoals/PURCHASE~WEBSITE',
          category: 'PURCHASE', origin: 'WEBSITE', biddable: true,
        } },
        { customerConversionGoal: {
          resourceName: 'customers/1234567890/customerConversionGoals/BEGIN_CHECKOUT~WEBSITE',
          category: 'BEGIN_CHECKOUT', origin: 'WEBSITE', biddable: false,
        } },
      ],
      campaignGoals: [
        { campaignConversionGoal: {
          resourceName: 'customers/1234567890/campaignConversionGoals/200~PURCHASE~WEBSITE',
          campaign: 'customers/1234567890/campaigns/200', category: 'PURCHASE', origin: 'WEBSITE', biddable: false,
        }, campaign: {
          resourceName: 'customers/1234567890/campaigns/200', id: '200', name: 'Custom goal campaign', status: 'ENABLED',
        } },
        { campaignConversionGoal: {
          resourceName: 'customers/1234567890/campaignConversionGoals/200~BEGIN_CHECKOUT~WEBSITE',
          campaign: 'customers/1234567890/campaigns/200', category: 'BEGIN_CHECKOUT', origin: 'WEBSITE', biddable: true,
        }, campaign: {
          resourceName: 'customers/1234567890/campaigns/200', id: '200', name: 'Custom goal campaign', status: 'ENABLED',
        } },
      ],
      customGoals: [{ customConversionGoal: {
        resourceName: 'customers/1234567890/customConversionGoals/9', id: '9', name: 'Checkout proxy', status: 'ENABLED',
        conversionActions: ['customers/1234567890/conversionActions/2', 'customers/1234567890/conversionActions/999'],
      } }],
      campaignConfigs: [
        { conversionGoalCampaignConfig: {
          resourceName: 'customers/1234567890/conversionGoalCampaignConfigs/100',
          campaign: 'customers/1234567890/campaigns/100', goalConfigLevel: 'CUSTOMER',
        }, campaign: {
          resourceName: 'customers/1234567890/campaigns/100', id: '100', name: 'Customer goals campaign', status: 'ENABLED',
        } },
        { conversionGoalCampaignConfig: {
          resourceName: 'customers/1234567890/conversionGoalCampaignConfigs/200',
          campaign: 'customers/1234567890/campaigns/200', goalConfigLevel: 'CAMPAIGN',
          customConversionGoal: 'customers/1234567890/customConversionGoals/9',
        }, campaign: {
          resourceName: 'customers/1234567890/campaigns/200', id: '200', name: 'Custom goal campaign', status: 'ENABLED',
        } },
      ],
      campaignGoalsComplete: true,
    })
    expect(result.metadata).toEqual({
      apiVersion: 'v25',
      requests: [
        { apiVersion: 'v25', operation: 'conversion-actions', requestId: 'req-conversion_action' },
        { apiVersion: 'v25', operation: 'customer-conversion-goals', requestId: 'req-customer_conversion_goal' },
        { apiVersion: 'v25', operation: 'campaign-conversion-goals', requestId: 'req-campaign_conversion_goal' },
        { apiVersion: 'v25', operation: 'custom-conversion-goals', requestId: 'req-custom_conversion_goal' },
        { apiVersion: 'v25', operation: 'conversion-goal-campaign-configs', requestId: 'req-conversion_goal_campaign_config' },
      ],
    })
  })

  it.each([[9_999, true], [10_000, false]] as const)(
    'marks campaign-goal evidence incomplete at the bounded row cap (%i rows)',
    async (rowCount, complete) => {
      const campaignGoals = Array.from({ length: rowCount }, (_, index) => ({
        campaignConversionGoal: {
          resourceName: `customers/1234567890/campaignConversionGoals/${index}~PURCHASE~WEBSITE`,
          campaign: `customers/1234567890/campaigns/${index}`,
          category: 'PURCHASE', origin: 'WEBSITE', biddable: true,
        },
        campaign: {
          resourceName: `customers/1234567890/campaigns/${index}`,
          id: String(index), name: `Campaign ${index}`, status: 'ENABLED',
        },
      }))
      let campaignGoalsQuery = ''
      const fetch: GoogleAdsFetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { query: string }
        const resource = /FROM ([a-z_]+)/.exec(body.query)?.[1]
        if (resource === 'campaign_conversion_goal') campaignGoalsQuery = body.query
        return new Response(JSON.stringify([{
          results: resource === 'campaign_conversion_goal' ? campaignGoals : [],
        }]), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      const client = new GoogleAdsClient({
        accessToken: 'access-token', developerToken: 'developer-token',
      }, { fetch })

      const result = await client.getConversionGoals('1234567890')

      expect(campaignGoalsQuery).toMatch(/\bLIMIT 10000$/)
      expect(result.data.campaignGoalsComplete).toBe(complete)
      expect(result.data.campaignGoals).toHaveLength(rowCount)
      for (let index = 0; index < rowCount; index++) {
        expect(result.data.campaignGoals[index]).toEqual({
          campaignConversionGoal: {
            resourceName: `customers/1234567890/campaignConversionGoals/${index}~PURCHASE~WEBSITE`,
            campaign: `customers/1234567890/campaigns/${index}`,
            category: 'PURCHASE', origin: 'WEBSITE', biddable: true,
          },
          campaign: {
            resourceName: `customers/1234567890/campaigns/${index}`,
            id: String(index), name: `Campaign ${index}`, status: 'ENABLED',
          },
        })
      }
    },
  )
})
