import { cfnTagToCloudFormation, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class OnPremisesStack extends Stack {
  private vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.vpcSetup();
  }

  private vpcSetup() {
    this.vpc = new ec2.Vpc(this, 'onprem_vpc', {
      cidr: '192.168.8.0/21',
      enableDnsSupport: true,
      enableDnsHostnames: true,
      subnetConfiguration: [],
    });
    Tags.of(this.vpc).add('Name', 'ONPREM');

    const internetGW = new ec2.CfnInternetGateway(this, 'IGW', {
      tags: [{key: 'Name', value: 'IGW-ONPREM'}]
    });

    const vpcIgwAttachment = new ec2.CfnVPCGatewayAttachment(this, 'vpcIgwAttachment', {
      vpcId: this.vpc.vpcId,
      internetGatewayId: internetGW.attrInternetGatewayId
    });

    const pubSubnet = new ec2.CfnSubnet(this, 'pubSubnet', {
      mapPublicIpOnLaunch: true,
      vpcId: this.vpc.vpcId,
      availabilityZone: this.availabilityZones[0],
      cidrBlock: '192.168.12.0/24',
      tags: [{key: 'Name', value: 'ONPREM-PUBLIC'}]
    });

    const priv1Subnet = new ec2.CfnSubnet(this, 'priv1Subnet', {
      vpcId: this.vpc.vpcId,
      availabilityZone: this.availabilityZones[0],
      cidrBlock: '192.168.10.0/24',
      tags: [{key: 'Name', value: 'ONPREM-PRIVATE-1'}]
    });

    const priv2Subnet = new ec2.CfnSubnet(this, 'priv2Subnet', {
      vpcId: this.vpc.vpcId,
      availabilityZone: this.availabilityZones[0],
      cidrBlock: '192.168.11.0/24',
      tags: [{key: 'Name', value: 'ONPREM-PRIVATE-2'}]
    });

    const publicRT = new ec2.CfnRouteTable(this, 'publicRT', {
      vpcId: this.vpc.vpcId,
      tags: [{key: 'Name', value: 'ONPREM-PUBLIC-RT'}]
    });

    const defaultRoute = new ec2.CfnRoute(this, 'defaultRoute', {
      gatewayId: internetGW.attrInternetGatewayId,
      routeTableId: publicRT.attrRouteTableId,
      destinationCidrBlock: '0.0.0.0/0',
    }).addDependsOn(vpcIgwAttachment);

    const priv1RT = new ec2.CfnRouteTable(this, 'priv1RT', {
      vpcId: this.vpc.vpcId,
      tags: [{key: 'Name', value: 'ONPREM-PRIVATE-RT1'}]
    });

    const priv2RT = new ec2.CfnRouteTable(this, 'priv2RT', {
      vpcId: this.vpc.vpcId,
      tags: [{key: 'Name', value: 'ONPREM-PRIVATE-RT2'}]
    });

    const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: this.vpc,
      description: 'Default ONPREM SG'
    });
    securityGroup.addIngressRule(ec2.Peer.ipv4('10.16.0.0/16'), ec2.Port.allTraffic(), 'Allow All from AWS Environment');

    const eniR1Private = new ec2.CfnNetworkInterface(this, 'eniR1Private', {
      subnetId: priv1Subnet.attrSubnetId,
      description: 'Router1 PRIVATE INTERFACE',
      groupSet: [securityGroup.securityGroupId],
      sourceDestCheck: false,
      tags: [{key: 'Name', value: 'ONPREM-ENI1-PRIVATE'}]
    });

    const eniR2Private = new ec2.CfnNetworkInterface(this, 'eniR2Private', {
      subnetId: priv2Subnet.attrSubnetId,
      description: 'Router2 PRIVATE INTERFACE',
      groupSet: [securityGroup.securityGroupId],
      sourceDestCheck: false,
      tags: [{key: 'Name', value: 'ONPREM-ENI2-PRIVATE'}]
    });

    const route1AwsIpv4 = new ec2.CfnRoute(this, 'route1AwsIpv4', {
      routeTableId: priv1RT.attrRouteTableId,
      destinationCidrBlock: '10.16.0.0/16',
      networkInterfaceId: eniR1Private.attrId
    });

    const route2AwsIpv4 = new ec2.CfnRoute(this, 'route2AwsIpv4', {
      routeTableId: priv2RT.attrRouteTableId,
      destinationCidrBlock: '10.16.0.0/16',
      networkInterfaceId: eniR2Private.attrId
    });

    const defaultRTToPubAssociation = new ec2.CfnSubnetRouteTableAssociation(this, 'defaultRTToPubAssociation', {
      subnetId: pubSubnet.attrSubnetId,
      routeTableId: publicRT.attrRouteTableId
    });

    const rtToPriv1Association = new ec2.CfnSubnetRouteTableAssociation(this, 'rtToPriv1Association', {
      subnetId: priv1Subnet.attrSubnetId,
      routeTableId: priv1RT.attrRouteTableId
    });

    const rtToPriv2Association = new ec2.CfnSubnetRouteTableAssociation(this, 'rtToPriv2Association', {
      subnetId: priv2Subnet.attrSubnetId,
      routeTableId: priv2RT.attrRouteTableId
    });
  }
}